"""Generate the completed 'Declaration of Non-Pregnancy' radiology consent by
stamping the patient's data + signature onto the official Meena template PDF.

The template is BILINGUAL — every label/blank exists twice: English on the left
half, Arabic on the right half — and the stamped values follow that convention:
the ENGLISH side always carries English, the ARABIC side always carries Arabic.
Values that arrive in one language only are put on BOTH sides by translating
them where that is reliable (procedure names via a radiology dictionary, HCG
results) and by mirroring names (a person's name is the same on both sides of a
bilingual form; only the Dr./د. title is swapped).

Arabic is rendered through PyMuPDF's `insert_htmlbox` (HarfBuzz shaping + RTL)
with the bundled Noto Naskh Arabic font; language-neutral values (MRN, dates,
weight, height, time) use crisp Helvetica and are stamped on both sides.

ALL coordinates are in PDF points (A4 = 595 x 842) and were MEASURED from the
template itself — get_text("words") for the labels/blanks, get_drawings() for
the checkbox rects and the sign-off table's cell borders (columns at x = 39 |
221 | 287 | 349 | 557). Don't nudge them by eye; re-measure.
"""
import io
import os
import re

_ASSETS = os.path.join(os.path.dirname(__file__), "assets")
_TEMPLATE = os.path.join(_ASSETS, "consent_non_pregnancy.pdf")
_FONT_DIR = os.path.join(_ASSETS, "fonts")
_FONT_REG = "NotoNaskhArabic-Regular.ttf"

# CSS shared by every stamped value box: bind the family name `naskh` to the
# bundled Arabic-capable TTF so both Arabic and Latin render from one font.
_CSS = (
    "@font-face{font-family:naskh;src:url(" + _FONT_REG + ");}"
    "*{font-family:naskh;margin:0;padding:0;color:#000;}"
)


def _esc(s):
    s = "" if s is None else str(s)
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;").replace("'", "&#39;"))


# Unicode bidi isolates — wrap ASCII runs (IDs like "(12345)", leftover English
# words inside a translated procedure) inside an Arabic (RTL) value so they render
# left-to-right with balanced parentheses instead of bidi-mirrored.
_FSI, _PDI = "⁨", "⁩"


def _isolate_ascii(text):
    return re.sub(r"([\x20-\x7E]+)", lambda m: _FSI + m.group(1) + _PDI, text)


def _is_arabic_ch(ch):
    o = ord(ch)
    return (0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F or
            0x08A0 <= o <= 0x08FF or 0xFB50 <= o <= 0xFDFF or 0xFE70 <= o <= 0xFEFF)


def _has_arabic(s):
    """True if the string contains any Arabic-script character."""
    return any(_is_arabic_ch(ch) for ch in (s or ""))


def _mostly_arabic(s):
    """True when Arabic letters outnumber Latin letters — the string should lay
    out RTL. A mostly-LATIN value with a lone Arabic title ("د. Khalid (12345)")
    must stay LTR: forcing RTL bidi-mirrors its parentheses."""
    ar = sum(1 for ch in (s or "") if _is_arabic_ch(ch))
    lat = sum(1 for ch in (s or "") if ch.isascii() and ch.isalpha())
    return ar > lat


# ── English → Arabic translation for the values the HIS sends in English, so the
# ARABIC side of the form is never left blank. Radiology exam names are built from
# a small vocabulary (modality + body part + contrast), which a phrase/word map
# translates well; anything unrecognized stays English inside the Arabic text
# (bidi-isolated) rather than blocking the translation.
_PROC_PHRASES = [
    (r"WITH\s*(?:AND|&)\s*WITHOUT\s*(?:IV\s*)?CONTRAST", "بالصبغة وبدونها"),
    (r"WITHOUT\s*(?:IV\s*)?CONTRAST|NON[- ]?CONTRAST|PLAIN", "بدون صبغة"),
    (r"WITH\s*(?:IV\s*)?CONTRAST|CONTRAST\s*ENHANCED|\bC\+", "بالصبغة"),
    (r"CERVICAL\s+SPINE|C[- ]?SPINE", "الفقرات العنقية"),
    (r"LUMBAR\s+SPINE|LS[- ]?SPINE|L[- ]?SPINE", "الفقرات القطنية"),
    (r"THORACIC\s+SPINE|D[- ]?SPINE|T[- ]?SPINE", "الفقرات الصدرية"),
    (r"WHOLE\s+ABDOMEN", "البطن كامل"),
    (r"URINARY\s+TRACT", "المسالك البولية"),
]
_PROC_WORDS = {
    "MRI": "رنين مغناطيسي", "MR": "رنين مغناطيسي", "MRCP": "رنين للقنوات الصفراوية",
    "MRA": "رنين للأوعية", "CT": "أشعة مقطعية", "CAT": "أشعة مقطعية",
    "CTA": "أشعة مقطعية للأوعية", "XRAY": "أشعة سينية", "X-RAY": "أشعة سينية",
    "XR": "أشعة سينية", "US": "موجات فوق صوتية", "U/S": "موجات فوق صوتية",
    "ULTRASOUND": "موجات فوق صوتية", "SONOGRAPHY": "موجات فوق صوتية",
    "MAMMOGRAM": "تصوير الثدي الإشعاعي", "MAMMOGRAPHY": "تصوير الثدي الإشعاعي",
    "MAMMO": "تصوير الثدي الإشعاعي", "DOPPLER": "دوبلر",
    "ANGIO": "تصوير الأوعية", "ANGIOGRAM": "تصوير الأوعية", "ANGIOGRAPHY": "تصوير الأوعية",
    "BRAIN": "الدماغ", "HEAD": "الرأس", "NECK": "الرقبة", "CHEST": "الصدر",
    "ABDOMEN": "البطن", "ABD": "البطن", "PELVIS": "الحوض", "SPINE": "العمود الفقري",
    "KNEE": "الركبة", "SHOULDER": "الكتف", "ANKLE": "الكاحل", "WRIST": "المعصم",
    "ELBOW": "المرفق", "HIP": "الورك", "HAND": "اليد", "FOOT": "القدم",
    "FEMUR": "عظم الفخذ", "TIBIA": "عظم الساق", "SKULL": "الجمجمة",
    "BREAST": "الثدي", "KIDNEY": "الكلى", "KIDNEYS": "الكلى", "RENAL": "الكلى",
    "LIVER": "الكبد", "PANCREAS": "البنكرياس", "KUB": "الكلى والحالب والمثانة",
    "UTERUS": "الرحم", "OVARIES": "المبايض", "THYROID": "الغدة الدرقية",
    "PITUITARY": "الغدة النخامية", "SINUS": "الجيوب الأنفية", "SINUSES": "الجيوب الأنفية",
    "PNS": "الجيوب الأنفية", "ORBIT": "محجر العين", "ORBITS": "محجر العين",
    "RIGHT": "يمين", "RT": "يمين", "LEFT": "يسار", "LT": "يسار",
    "BILATERAL": "الجانبين", "BOTH": "الجانبين", "AND": "و", "&": "و", "+": "و",
    "WITH": "مع", "SCREENING": "فحص", "SCAN": "تصوير", "PPD": "", "IV": "",
}


def _procedure_ar(text):
    """Translate an English radiology exam name to Arabic. Phrases first, then
    word-by-word; unknown words stay English inside the Arabic string. Returns ''
    when nothing translated (better an empty Arabic side than English there)."""
    src = " " + re.sub(r"\s+", " ", str(text or "").strip().upper()) + " "
    for pat, ar in _PROC_PHRASES:
        src = re.sub(r"(?<=[\s(])(?:%s)(?=[\s),.])" % pat, " %s " % ar, src)
    out = []
    for tok in src.split():
        out.append(_PROC_WORDS.get(tok, tok) if not _has_arabic(tok) else tok)
    res = re.sub(r"\s+", " ", " ".join(t for t in out if t)).strip()
    return res if _has_arabic(res) else ""


_HCG_MAP = {
    "negative": "سلبي", "neg": "سلبي", "-ve": "سلبي",
    "positive": "إيجابي", "pos": "إيجابي", "+ve": "إيجابي",
    "pending": "قيد النتيجة", "na": "لا ينطبق", "n/a": "لا ينطبق",
    "not applicable": "لا ينطبق", "not done": "لم يُجرَ",
}
_HCG_REV = {"سلبي": "Negative", "إيجابي": "Positive", "قيد النتيجة": "Pending",
            "لا ينطبق": "N/A", "لم يجر": "Not done", "لم يُجرَ": "Not done"}


def _split_bilingual(raw, translate_ar=None, translate_en=None, mirror=False):
    """Split one value into (english_side, arabic_side). A value in one language
    fills the other side via the given translator; `mirror` puts the SAME value on
    both sides when no translation exists (used for person names, which stay the
    same on a bilingual form)."""
    raw = str(raw or "").strip()
    if not raw:
        return "", ""
    if _has_arabic(raw):
        en = (translate_en(raw) if translate_en else "") or (raw if mirror else "")
        return en, raw
    ar = (translate_ar(raw) if translate_ar else "") or (raw if mirror else "")
    return raw, ar


def _staff_pair(raw):
    """(english_side, arabic_side) for a physician/technologist NAME. A person's
    name can't be translated, so it is mirrored VERBATIM into both columns — the
    standard on bilingual forms. (No title swapping: a half-swapped 'Dr. خالد'
    mixes scripts mid-string and the bidi mangles the punctuation.)"""
    raw = str(raw or "").strip()
    return (raw, raw) if raw else ("", "")


# ── Value boxes (x0, y0, x1, y1). `side` pins the text to the box edge facing its
# label: 'left' for the English half, 'right' for the Arabic half. (In this
# renderer text-align is inverted under RTL, so the align that pins each
# direction to an edge is computed in put_html.)
_HTML_FIELDS = {
    #                  box                    size  side
    "name_en":      ((128, 126, 300, 141), 10, "left"),   # after "Name of Patient:" (ends x=123)
    "name_ar":      ((305, 126, 495, 141), 10, "right"),  # before "اسم المريض:" (colon x=503)
    "procedure_en": ((128, 172, 320, 187), 10, "left"),
    "procedure_ar": ((324, 172, 522, 187), 10, "right"),  # "الإجراء:" colon at x=526
    "hcg_en":       ((128, 216, 280, 231), 9,  "left"),
    "hcg_ar":       ((284, 216, 442, 231), 9,  "right"),  # "نتيجة …:" colon at x=446
    # "I, the undersigned ______": ENGLISH blank x=130–267 (y≈512), ARABIC blank
    # x=396–495 (y≈508). y offsets sit each name ON its line, clear of the section's
    # top border (a rule at y≈505 that struck the text when boxes started higher).
    "undersigned_en": ((135, 507, 265, 522), 9, "left"),
    "undersigned_ar": ((398, 504, 493, 519), 9, "right"),
}

# ── Sign-off table (columns measured at x = 39 | 221 | 287 | 349 | 557; rows at
# y = 628 | 656 | 684 | 725 | 754 | 775). Values must stay INSIDE their cell:
# the Arabic side in the free space of the ARABIC label cell (x 349–557, ending
# before the label text), the English side under the ENGLISH label (cell 39–221).
_CELL_FIELDS = {
    # Patient row (y 628–656): Arabic label "اسم المريضة/ممثلها القانوني:" starts x=443;
    # the English label fills its first line, so the EN name takes the second line.
    "sig_name":     {"ar": (351, 631, 441, 649), "en": (46, 641, 218, 655), "size": 8},
    # Physician row (y 656–684): Arabic label starts x=449.
    "physician":    {"ar": (351, 662, 446, 680), "en": (48, 669, 218, 683), "size": 8},
    # Technologist row (y 685–725): Arabic label starts x=423; the English label wraps
    # ("… +ID / No)."), so the EN value sits below the second label line.
    "technologist": {"ar": (351, 694, 420, 712), "en": (48, 712, 218, 724), "size": 8},
}

# Pure Latin / numeric values — crisp Helvetica at exact baselines. Language-neutral
# digits are stamped on BOTH sides of the bilingual form: (x, y) per side.
_TEXT_FIELDS = {
    "mrn":      [(132, 151)],
    "dob":      [(132, 166)],
    "weight":   [(132, 197)],
    "height":   [(132, 212)],
    # LMP date: English blank x=202–278, Arabic blank x=364–446 (same row, y≈410).
    "lmp_date": [(222, 410), (372, 410)],
    # Bottom row: "Date:"/"Time:" on the left; "الوقت:" colon at x=398 (value ends
    # ≈395) and "التاريخ:" colon at x=525 (value ends ≈522) on the right.
    "date":     [(80, 765), (474, 765)],
    "time":     [(220, 765), (368, 765)],
}

# Checkbox marks — the form has PAIRS of checkboxes: English side + Arabic side
# (measured rects; EN boxes at x=45/176, AR boxes at x=553/442). BOTH get the X.
_CHECKS = {
    "outpatient":   [(180, 241), (444, 241)],
    "er":           [(180, 255), (444, 256)],
    "not_pregnant": [(47, 354), (555, 354)],
    "not_married":  [(47, 393), (555, 393)],
    "lmp":          [(47, 410), (555, 410)],
    "iud":          [(47, 425), (555, 425)],
    "risks":        [(47, 456), (555, 456)],
    "read":         [(47, 536), (555, 536)],
}

# Signature — the patient row's TWO signature cells ("Signature" x 221–287 and
# "التوقيع" x 287–349) form one signing area; the image must NOT spill into the
# Arabic name cell (border at x=349). White patch under it erases the hints.
_SIG_RECT = (226, 631, 344, 653)
_SIG_WHITE = (222.5, 629, 348, 655)


def _stamp(page, data, signature_png=None, mark_declaration=True):
    """Stamp the patient data + checkmarks (+ optional signature image) onto a page
    of the official template. `mark_declaration` marks the always-affirmed boxes
    (not-pregnant / risks / read) — set False for a blank read-only preview."""
    import fitz

    arch = fitz.Archive(_FONT_DIR)

    def put_latin(point, text, size=9):
        if text is None:
            return
        text = str(text).strip()
        if not text:
            return
        page.insert_text((point[0], point[1]), text, fontsize=size,
                         fontname="helv", color=(0, 0, 0))

    def put_html(box, text, size, side):
        if text is None:
            return
        text = str(text).strip()
        if not text:
            return
        x0, y0, x1, y1 = box
        # Direction by MAJORITY script: a value that's mostly Latin with a lone
        # Arabic title stays LTR (RTL would mirror its parentheses); a mostly-
        # Arabic value lays out RTL with its ASCII runs (IDs) bidi-isolated.
        rtl = _mostly_arabic(text)
        body = _esc(_isolate_ascii(text)) if rtl else _esc(text)
        # This renderer inverts text-align under RTL, so the align that PINS the
        # text to the requested edge depends on the content's direction:
        #   pin LEFT  → align 'left' for LTR text, 'right' for RTL text
        #   pin RIGHT → align 'right' for LTR text, 'left' for RTL text
        if side == "right":
            align = "left" if rtl else "right"
        else:
            align = "right" if rtl else "left"
        html = ('<div style="font-size:%dpt;line-height:1.05;white-space:nowrap;'
                'text-align:%s;direction:%s;">%s</div>') % (
                    size, align, "rtl" if rtl else "ltr", body)
        # scale_low lets the shaper shrink an over-long value to fit rather than clip.
        page.insert_htmlbox(fitz.Rect(x0, y0, x1, y1), html, css=_CSS,
                            archive=arch, scale_low=0.5)

    # ── Derive the English-side / Arabic-side value for every bilingual field, so
    # BOTH halves of the form are filled and each half is in its own language.
    raw_name = str(data.get("name") or "").strip()
    raw_en = str(data.get("name_en") or "").strip()
    ar_name = raw_name if _has_arabic(raw_name) else (raw_en if _has_arabic(raw_en) else "")
    en_name = raw_en if (raw_en and not _has_arabic(raw_en)) else (raw_name if not _has_arabic(raw_name) else "")
    # A name existing in one language only is mirrored — same name on both sides.
    ar_name = ar_name or en_name
    en_name = en_name or ar_name

    proc_en, proc_ar = _split_bilingual(data.get("procedure"), translate_ar=_procedure_ar)
    hcg_raw = str(data.get("hcg") or "").strip()
    if hcg_raw and not re.search(r"[A-Za-z؀-ۿ]", hcg_raw):
        hcg_en = hcg_ar = hcg_raw          # numeric titre — language-neutral, both sides
    else:
        hcg_en, hcg_ar = _split_bilingual(
            hcg_raw,
            translate_ar=lambda v: _HCG_MAP.get(v.lower().strip()),
            translate_en=lambda v: _HCG_REV.get(v.strip()))
    phys_en, phys_ar = _staff_pair(data.get("physician"))
    tech_en, tech_ar = _staff_pair(data.get("technologist"))

    values = {
        "name_en": en_name, "name_ar": ar_name,
        "procedure_en": proc_en, "procedure_ar": proc_ar,
        "hcg_en": hcg_en, "hcg_ar": hcg_ar,
        # Both declaration lines carry the signer — each side in its language.
        "undersigned_en": en_name, "undersigned_ar": ar_name,
    }
    for key, (box, size, side) in _HTML_FIELDS.items():
        put_html(box, values.get(key), size, side)

    # Sign-off table: both cells of each row — English side + Arabic side.
    for key, (en_v, ar_v) in {"sig_name": (en_name, ar_name),
                              "physician": (phys_en, phys_ar),
                              "technologist": (tech_en, tech_ar)}.items():
        spec = _CELL_FIELDS[key]
        put_html(spec["en"], en_v, spec["size"], "left")
        put_html(spec["ar"], ar_v, spec["size"], "right")

    for key, points in _TEXT_FIELDS.items():
        for pt in points:
            put_latin(pt, data.get(key))

    marks = set()
    if mark_declaration:
        marks |= {"not_pregnant", "risks", "read"}
    if data.get("patient_type") == "er":
        marks.add("er")
    elif data.get("patient_type") == "outpatient":
        marks.add("outpatient")
    reason = data.get("reason")
    if reason in ("not_married", "lmp", "iud"):
        marks.add(reason)
    for key in marks:
        for pt in _CHECKS.get(key, ()):
            page.insert_text((pt[0], pt[1]), "X", fontsize=11, fontname="helv", color=(0, 0, 0))

    if signature_png:
        try:
            # Lay a clean WHITE background over the signature cells first (clears the
            # "Signature / التوقيع" placeholder hints) so the ink always sits on white,
            # then drop the signature image on top — kept inside the two signature
            # cells so it never covers the table borders or the Arabic name cell.
            page.draw_rect(fitz.Rect(*_SIG_WHITE), color=None, fill=(1, 1, 1))
            page.insert_image(fitz.Rect(*_SIG_RECT), stream=signature_png, keep_proportion=True)
        except Exception:
            pass  # a bad/empty signature must not fail the whole document


def generate_consent_pdf(data, signature_png=None):
    """Complete, signed consent PDF (bytes). `data`: field values + checkbox choices
    (see _HTML_FIELDS/_TEXT_FIELDS/_CHECKS). `signature_png`: PNG bytes of the signature."""
    import fitz  # PyMuPDF
    doc = fitz.open(_TEMPLATE)
    _stamp(doc[0], data, signature_png)
    out = doc.tobytes()
    doc.close()
    return out


def render_consent_png(data, scale=2.0):
    """Render the OFFICIAL form (page 1) pre-filled with the patient's data as a PNG
    image, so the patient sees the real Meena form on her phone before signing. No
    signature is stamped; the declaration boxes are shown ticked."""
    import fitz
    doc = fitz.open(_TEMPLATE)
    _stamp(doc[0], data, signature_png=None, mark_declaration=True)
    pix = doc[0].get_pixmap(matrix=fitz.Matrix(scale, scale))
    png = pix.tobytes("png")
    doc.close()
    return png
