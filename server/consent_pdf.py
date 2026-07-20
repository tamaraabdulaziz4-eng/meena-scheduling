"""Generate the completed 'Declaration of Non-Pregnancy' radiology consent by
stamping the patient's data + signature onto the official Meena template PDF.

The template already carries the bilingual (Arabic/English) BODY text. What we
stamp are the per-patient VALUES — and those can be Arabic (patient name,
procedure, physician/technologist names). Helvetica has no Arabic glyphs, so
Arabic values used to come out as dots. We now render any value that may contain
Arabic through PyMuPDF's `insert_htmlbox`, which shapes Arabic + handles RTL via
HarfBuzz, using the bundled Noto Naskh Arabic font. Pure-Latin/numeric fields
(MRN, dates, weight, height, time) still use plain Helvetica for crispness.

Coordinates are in PDF points (A4 = 595 x 842), derived from the template's own
label positions (measured with get_text("words")).
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
    """True if the string contains any Arabic-script character. Used to pick the
    text DIRECTION per value: Arabic → RTL, Latin/digits → LTR. Forcing RTL on a
    Latin value ('Dr. Khalid (12345)') bidi-reorders the punctuation, so we only
    go RTL when the value is actually Arabic."""
    for ch in (s or ""):
        o = ord(ch)
        if (0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F or
                0x08A0 <= o <= 0x08FF or 0xFB50 <= o <= 0xFDFF or 0xFE70 <= o <= 0xFEFF):
            return True
    return False


# ── Value boxes (x0, y0, x1, y1) for fields that MAY contain Arabic. Rendered with
# insert_htmlbox so Arabic shapes correctly. The form is BILINGUAL — English labels on
# the left, Arabic labels on the right — so values follow the same convention. In this
# renderer, text-align:left makes an ARABIC value settle on the RIGHT of its (wide) box
# (beside the Arabic label) and a LATIN value on the LEFT (beside the English label). So
# a single wide box auto-places each value on the correct side by its language; the name
# renders in BOTH languages (English left + Arabic right) via two boxes.
_HTML_FIELDS = {
    #                x0   y0   x1   y1   size
    "name_en":     (128, 126, 300, 141, 10),   # English name → left, by "Name of Patient:"
    "name":        (305, 126, 495, 141, 10),   # Arabic name  → right, by "اسم المريض"
    "procedure":   (128, 172, 440, 187, 10),   # single value: Arabic→right / Latin→left
    "hcg":         (128, 218, 440, 233, 9),
    "undersigned": (140, 508, 345, 523, 9),
    # Physician / technologist names live in the leftmost cell of the sign-off
    # table (x 44–235). Placed on the line just under their long English label,
    # small font so a name + ID number stays inside the cell.
    "physician":   (48, 670, 232, 685, 8),
    # Its English label wraps to two lines ("… +ID / No)."), so the value sits a
    # line lower than the physician's to clear the "No)." on the second line.
    "technologist":(48, 711, 232, 726, 8),
}

# Pure Latin / numeric values — crisp Helvetica at an exact baseline (x, y). These are
# language-neutral (digits/dates) and stay on the LEFT beside their English label.
_TEXT_FIELDS = {
    "mrn":       (132, 151),
    "dob":       (132, 166),
    "weight":    (132, 197),
    "height":    (132, 212),
    "lmp_date":  (222, 410),
    "date":      (80, 765),
    "time":      (220, 765),
}

# Checkbox marks: an "X" placed at the box.
_CHECKS = {
    "outpatient":   (180, 241),
    "er":           (180, 255),
    "not_pregnant": (47, 356),
    "not_married":  (47, 393),
    "lmp":          (47, 410),
    "iud":          (47, 426),
    "risks":        (47, 455),
    "read":         (47, 536),
}
# Signature image box (x0, y0, x1, y1) — the Signature cell of the Patient row.
_SIG_RECT = (240, 627, 424, 656)
# A slightly larger white patch drawn UNDER the signature to fully erase the
# "Signature / التوقيع" placeholder hint (spans x≈235–430) so no sliver peeks out.
_SIG_WHITE = (233, 623, 431, 659)


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
        # Direction follows the CONTENT (Arabic → RTL, Latin → LTR). Alignment is always
        # text-align:left, which in this renderer settles an Arabic value on the RIGHT of
        # the box (beside the Arabic label) and a Latin value on the LEFT (beside the
        # English label) — the form's bilingual convention. For an Arabic value carrying
        # an ASCII ID ("د. خالد (12345)"), isolate the ASCII run so its digits +
        # parentheses stay LTR and balanced instead of bidi-mirrored.
        if _has_arabic(text):
            direction, body = "rtl", _esc(_isolate_ascii(text))
        else:
            direction, body = "ltr", _esc(text)
        html = ('<div style="font-size:%dpt;line-height:1.05;white-space:nowrap;'
                'text-align:left;direction:%s;">%s</div>') % (size, direction, body)
        # scale_low lets the shaper shrink an over-long name to fit rather than clip.
        page.insert_htmlbox(fitz.Rect(x0, y0, x1, y1), html, css=_CSS,
                            archive=arch, scale_low=0.5)

    for key, box in _HTML_FIELDS.items():
        put_html(box[:4], data.get(key), box[4])
    for key, point in _TEXT_FIELDS.items():
        put_latin(point, data.get(key))

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
        pt = _CHECKS.get(key)
        if pt:
            page.insert_text((pt[0], pt[1]), "X", fontsize=11, fontname="helv", color=(0, 0, 0))

    if signature_png:
        try:
            # Lay a clean WHITE background over the signature cell first (clears the
            # "Signature / التوقيع" placeholder hint) so the ink always sits on white,
            # then drop the signature image on top.
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
