"""Generate the completed 'Declaration of Non-Pregnancy' radiology consent by
stamping the patient's data + signature onto the official Meena template PDF.

We only ever stamp Latin text, numbers, checkmarks and the signature IMAGE onto
the template — the bilingual (Arabic/English) body text is already printed on the
template — so there is NO Arabic text shaping to do here. Coordinates are in PDF
points (A4 = 595 x 842), derived from the template's own label positions.
"""
import io
import os

_TEMPLATE = os.path.join(os.path.dirname(__file__), "assets", "consent_non_pregnancy.pdf")

# Value anchor points (x, baseline_y) for each stamped field, in PDF points.
_FIELDS = {
    "name":       (132, 136),
    "mrn":        (132, 151),
    "dob":        (132, 166),
    "procedure":  (132, 182),
    "weight":     (132, 197),
    "height":     (132, 212),
    "hcg":        (132, 226),
    "lmp_date":   (222, 410),
    "undersigned": (135, 520),
    # Physician / technologist names sit on their OWN line in the left cell — the old
    # position (x=215) spilled into the signature column, printing over that cell.
    "physician":  (48, 681),
    "technologist": (48, 722),
    # Date / time on the label baseline (were stamped a row too low, under the border).
    "date":       (80, 765),
    "time":       (220, 765),
}
# Per-field font size overrides (physician/tech IDs can be long → smaller to stay in cell).
_FIELD_SIZE = {"physician": 8, "technologist": 8}
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
# Signature image box (x0, y0, x1, y1) — the Signature cell of the Patient row. Sized to
# sit INSIDE that cell (was shifted left, overlapping the "Signature / التوقيع" hint).
_SIG_RECT = (236, 624, 424, 655)


def _stamp(page, data, signature_png=None, mark_declaration=True):
    """Stamp the patient data + checkmarks (+ optional signature image) onto a page
    of the official template. `mark_declaration` marks the always-affirmed boxes
    (not-pregnant / risks / read) — set False for a blank read-only preview."""
    import fitz

    def put(point, text, size=9):
        if text is None:
            return
        text = str(text).strip()
        if not text:
            return
        page.insert_text((point[0], point[1]), text, fontsize=size, fontname="helv", color=(0, 0, 0))

    for key, point in _FIELDS.items():
        put(point, data.get(key), _FIELD_SIZE.get(key, 9))

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
            # White out the "Signature / التوقيع" placeholder hint first so the signature
            # sits on a clean cell instead of on top of that text.
            page.draw_rect(fitz.Rect(*_SIG_RECT), color=None, fill=(1, 1, 1))
            page.insert_image(fitz.Rect(*_SIG_RECT), stream=signature_png, keep_proportion=True)
        except Exception:
            pass  # a bad/empty signature must not fail the whole document


def generate_consent_pdf(data, signature_png=None):
    """Complete, signed consent PDF (bytes). `data`: field values + checkbox choices
    (see _FIELDS/_CHECKS). `signature_png`: PNG bytes of the captured signature."""
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
