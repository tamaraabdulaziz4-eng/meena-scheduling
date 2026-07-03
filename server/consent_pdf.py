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
    "physician":  (215, 672),
    "technologist": (215, 700),
    "date":       (92, 779),
    "time":       (232, 779),
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
# Signature image box (x0, y0, x1, y1).
_SIG_RECT = (215, 618, 340, 653)


def generate_consent_pdf(data, signature_png=None):
    """data: dict of string field values (see _FIELDS keys) plus booleans for the
    checkboxes ('outpatient'/'er'/'not_married'/'lmp'/'iud'). `not_pregnant`,
    `risks` and `read` are always marked (the patient is signing the declaration).
    signature_png: PNG bytes of the captured signature (optional).
    Returns the completed PDF as bytes."""
    import fitz  # PyMuPDF

    doc = fitz.open(_TEMPLATE)
    page = doc[0]

    def put(point, text, size=9):
        if text is None:
            return
        text = str(text).strip()
        if not text:
            return
        page.insert_text((point[0], point[1]), text, fontsize=size, fontname="helv", color=(0, 0, 0))

    for key, point in _FIELDS.items():
        put(point, data.get(key))

    # Checkboxes the signature always affirms, plus the ones chosen.
    marks = {"not_pregnant", "risks", "read"}
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
            page.insert_image(fitz.Rect(*_SIG_RECT), stream=signature_png, keep_proportion=True)
        except Exception:
            pass  # a bad/empty signature must not fail the whole document

    out = doc.tobytes()
    doc.close()
    return out
