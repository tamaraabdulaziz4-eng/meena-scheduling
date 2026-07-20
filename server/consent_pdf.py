"""Generate the completed 'Declaration of Non-Pregnancy' radiology consent by
stamping the patient's data + signature onto the official Meena template PDF.

The template is BILINGUAL — every label/blank exists twice: English on the left
half, Arabic on the right half — and the stamped values follow that convention:
Arabic values print beside the Arabic labels (right), English values beside the
English labels (left), the patient's name in BOTH languages, and the checkbox
marks go into BOTH the English and Arabic checkbox of each pair.

Arabic is rendered through PyMuPDF's `insert_htmlbox` (HarfBuzz shaping + RTL)
with the bundled Noto Naskh Arabic font; language-neutral values (MRN, dates,
weight, height, time) use crisp Helvetica.

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


# Unicode bidi isolates — wrap ASCII runs (IDs like "(12345)", room "A12") inside an
# Arabic (RTL) value so they render left-to-right with balanced parentheses instead of
# bidi-mirrored. FSI = First-Strong Isolate, PDI = Pop Directional Isolate.
_FSI, _PDI = "⁨", "⁩"


def _isolate_ascii(text):
    return re.sub(r"([\x20-\x7E]+)", lambda m: _FSI + m.group(1) + _PDI, text)


def _has_arabic(s):
    """True if the string contains any Arabic-script character. Used to route each
    value to the correct SIDE of the bilingual form and pick its direction."""
    for ch in (s or ""):
        o = ord(ch)
        if (0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F or
                0x08A0 <= o <= 0x08FF or 0xFB50 <= o <= 0xFDFF or 0xFE70 <= o <= 0xFEFF):
            return True
    return False


# ── Generic value boxes (x0, y0, x1, y1, size). Rendered with insert_htmlbox; an
# Arabic value settles on the RIGHT edge of its box (text-align:left inverts under
# RTL), a Latin value on the LEFT — so wide boxes auto-place single values on the
# correct side. Boxes stop just short of the Arabic label's colon.
_HTML_FIELDS = {
    #                 x0   y0   x1   y1  size
    "name_en":      (128, 126, 300, 141, 10),  # left, after "Name of Patient:" (label ends x=123)
    "name":         (305, 126, 495, 141, 10),  # right, before "اسم المريض:" (colon at x=503)
    "procedure":    (128, 172, 522, 187, 10),  # "الإجراء:" colon at x=526
    "hcg":          (128, 216, 442, 231, 9),   # "نتيجة تحليل الحمل ان وجد:" colon at x=446
    # "I, the undersigned ______" — the ENGLISH blank runs x=130–267 (y≈512), the
    # ARABIC blank runs x=396–495 (y≈508, right before "أنا الموقعة أدناه"). The y
    # offsets put each name ON its blank line, clear of the section's top border
    # (a rule at y≈505 that struck the text when the boxes started higher).
    "undersigned_en": (135, 507, 265, 522, 9),
    "undersigned":    (398, 504, 493, 519, 9),
}

# ── Sign-off table (columns measured at x = 39 | 221 | 287 | 349 | 557; rows at
# y = 628 | 656 | 684 | 725 | 754 | 775). The value must stay INSIDE its cell:
# an Arabic name goes in the free space of the ARABIC label cell (x 349–557,
# ending before the label text), an English name under the ENGLISH label
# (cell x 39–221). Keyed as {field: {"ar": box, "en": box, "size": n}}.
_CELL_FIELDS = {
    # Patient row (y 628–656): Arabic label "اسم المريضة/ممثلها القانوني:" starts x=443;
    # English label fills its cell's first line, so the EN name takes the second line.
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

    def put_html(box, text, size):
        if text is None:
            return
        text = str(text).strip()
        if not text:
            return
        x0, y0, x1, y1 = box
        # Direction follows the CONTENT (Arabic → RTL, Latin → LTR). text-align:left
        # settles Arabic on the box's right edge and Latin on its left. An ASCII ID
        # inside an Arabic value ("د. خالد (12345)") is bidi-isolated so its digits
        # and parentheses stay LTR and balanced.
        if _has_arabic(text):
            direction, body = "rtl", _esc(_isolate_ascii(text))
        else:
            direction, body = "ltr", _esc(text)
        html = ('<div style="font-size:%dpt;line-height:1.05;white-space:nowrap;'
                'text-align:left;direction:%s;">%s</div>') % (size, direction, body)
        # scale_low lets the shaper shrink an over-long name to fit rather than clip.
        page.insert_htmlbox(fitz.Rect(x0, y0, x1, y1), html, css=_CSS,
                            archive=arch, scale_low=0.5)

    # Route the patient's name(s) by language so each side of the form shows the
    # right one: Arabic name by the Arabic label, English name by the English label.
    raw_name = str(data.get("name") or "").strip()
    raw_en = str(data.get("name_en") or "").strip()
    name_ar = raw_name if _has_arabic(raw_name) else ""
    name_en = raw_en or ("" if _has_arabic(raw_name) else raw_name)

    values = dict(data)
    values["name"] = name_ar
    values["name_en"] = name_en
    # "I, the undersigned ____ / أنا الموقعة أدناه ____": each language's blank gets
    # the matching name so BOTH declaration lines carry the signer.
    und = str(data.get("undersigned") or "").strip() or raw_name or raw_en
    if _has_arabic(und):
        values["undersigned"], values["undersigned_en"] = und, name_en
    else:
        values["undersigned"], values["undersigned_en"] = name_ar, und

    for key, box in _HTML_FIELDS.items():
        put_html(box[:4], values.get(key), box[4])

    # Sign-off table cells: route each value to the Arabic or English cell by its
    # own language, so it sits beside the matching label and inside the borders.
    cell_values = {"sig_name": name_ar or name_en,
                   "physician": data.get("physician"),
                   "technologist": data.get("technologist")}
    for key, spec in _CELL_FIELDS.items():
        val = str(cell_values.get(key) or "").strip()
        if not val:
            continue
        put_html(spec["ar" if _has_arabic(val) else "en"], val, spec["size"])
    # Patient row: when both names exist, show BOTH (Arabic in the Arabic cell,
    # English under the English label) — same as the top Name row.
    if name_ar and name_en:
        put_html(_CELL_FIELDS["sig_name"]["en"], name_en, _CELL_FIELDS["sig_name"]["size"])

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
