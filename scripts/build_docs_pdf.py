"""Generate branded Meena PDF docs: project overview + role guides."""
import os
from fpdf import FPDF

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(ROOT, "dashboard", "meena_logo.png")
FREG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FBLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

VIOLET = (107, 78, 255)
DEEP   = (38, 30, 79)
LAV    = (244, 241, 253)
BAND   = (236, 231, 251)
MUTED  = (133, 133, 168)
PINK   = (255, 82, 119)
GREEN  = (0, 135, 90)
TEXT   = (43, 36, 80)
WHITE  = (255, 255, 255)


class Doc(FPDF):
    def __init__(self, title):
        super().__init__("P", "mm", "A4")
        self.doc_title = title
        self.set_auto_page_break(True, margin=20)
        self.add_font("DJ", "", FREG)
        self.add_font("DJ", "B", FBLD)
        self.set_title(title)

    def header(self):
        if self.page_no() == 1:
            return                       # cover draws its own
        self.set_fill_color(*BAND)
        self.rect(0, 0, 210, 18, style="F")
        try:
            self.image(LOGO, 10, 4.5, 26)
        except Exception:
            pass
        self.set_xy(40, 6)
        self.set_font("DJ", "B", 10)
        self.set_text_color(*DEEP)
        self.cell(0, 6, self.doc_title)
        self.set_y(26)

    def footer(self):
        if self.page_no() == 1:
            return
        self.set_y(-14)
        self.set_font("DJ", "", 8)
        self.set_text_color(*MUTED)
        self.cell(0, 6, "Meena Health  ·  Radiology Scheduling", align="L")
        self.cell(0, 6, f"{self.page_no()}", align="R")

    # ── building blocks ──
    def cover(self, subtitle, tagline):
        self.add_page()
        self.set_fill_color(*LAV)
        self.rect(0, 0, 210, 297, style="F")
        # logo chip
        self.set_fill_color(*WHITE)
        self._rrect(72, 60, 66, 40, 6, WHITE)
        try:
            self.image(LOGO, 84, 70, 42)
        except Exception:
            pass
        self.set_xy(0, 120)
        self.set_font("DJ", "B", 30)
        self.set_text_color(*DEEP)
        self.cell(0, 16, self.doc_title, align="C", new_x="LMARGIN", new_y="NEXT")
        self.set_font("DJ", "B", 15)
        self.set_text_color(*VIOLET)
        self.cell(0, 10, subtitle, align="C", new_x="LMARGIN", new_y="NEXT")
        self.ln(4)
        self.set_font("DJ", "", 12)
        self.set_text_color(*MUTED)
        self.set_x(30)
        self.multi_cell(150, 7, tagline, align="C")
        # footer strip
        self.set_xy(0, 270)
        self.set_font("DJ", "", 10)
        self.set_text_color(*MUTED)
        self.cell(0, 6, "Meena Health  ·  Radiology Department", align="C")

    def _rrect(self, x, y, w, h, r, fill):
        self.set_fill_color(*fill)
        try:
            self.rect(x, y, w, h, round_corners=True, style="F")
        except Exception:
            self.rect(x, y, w, h, style="F")

    def h1(self, text):
        if self.get_y() > 250:
            self.add_page()
        self.ln(3)
        self.set_fill_color(*VIOLET)
        self.rect(self.l_margin, self.get_y() + 1, 3, 7, style="F")
        self.set_x(self.l_margin + 6)
        self.set_font("DJ", "B", 16)
        self.set_text_color(*DEEP)
        self.cell(0, 9, text, new_x="LMARGIN", new_y="NEXT")
        self.ln(1)

    def h2(self, text):
        if self.get_y() > 255:
            self.add_page()
        self.ln(1)
        self.set_font("DJ", "B", 12)
        self.set_text_color(*VIOLET)
        self.cell(0, 7, text, new_x="LMARGIN", new_y="NEXT")

    def para(self, text):
        self.set_font("DJ", "", 10.5)
        self.set_text_color(*TEXT)
        self.multi_cell(0, 5.6, text)
        self.ln(1)

    def bullets(self, items):
        self.set_font("DJ", "", 10.5)
        for it in items:
            self.set_text_color(*VIOLET)
            self.set_x(self.l_margin + 2)
            self.cell(5, 5.6, "•")
            self.set_text_color(*TEXT)
            x = self.get_x()
            self.multi_cell(0, 5.6, it)
            self.set_x(self.l_margin)
        self.ln(1)

    def steps(self, items):
        self.set_font("DJ", "", 10.5)
        for i, it in enumerate(items, 1):
            self.set_text_color(*VIOLET)
            self.set_x(self.l_margin + 1)
            self.set_font("DJ", "B", 10.5)
            self.cell(7, 5.6, f"{i}.")
            self.set_font("DJ", "", 10.5)
            self.set_text_color(*TEXT)
            self.multi_cell(0, 5.6, it)
            self.set_x(self.l_margin)
        self.ln(1)

    def callout(self, text, color=BAND):
        self.ln(1)
        self.set_font("DJ", "", 10)
        y0 = self.get_y()
        self.set_fill_color(*color)
        # estimate height
        lines = self.multi_cell(0, 5.4, text, dry_run=True, output="LINES")
        h = len(lines) * 5.4 + 6
        self._rrect(self.l_margin, y0, 190, h, 3, color)
        self.set_xy(self.l_margin + 4, y0 + 3)
        self.set_text_color(*DEEP)
        self.multi_cell(182, 5.4, text)
        self.set_y(y0 + h + 2)

    def table(self, headers, rows, widths):
        self.ln(1)
        self.set_font("DJ", "B", 9.5)
        self.set_fill_color(*VIOLET)
        self.set_text_color(*WHITE)
        for h, w in zip(headers, widths):
            self.cell(w, 8, " " + h, fill=True)
        self.ln()
        self.set_font("DJ", "", 9.5)
        for ri, row in enumerate(rows):
            fill = ri % 2 == 1
            self.set_fill_color(243, 240, 252) if fill else self.set_fill_color(*WHITE)
            # row height = max lines
            cells = []
            maxlines = 1
            for val, w in zip(row, widths):
                ls = self.multi_cell(w, 5, str(val), dry_run=True, output="LINES")
                cells.append(ls); maxlines = max(maxlines, len(ls))
            rh = maxlines * 5 + 2
            x0, y0 = self.get_x(), self.get_y()
            if y0 + rh > 280:
                self.add_page(); x0, y0 = self.get_x(), self.get_y()
            for ci, (val, w) in enumerate(zip(row, widths)):
                self.set_xy(x0, y0)
                self.set_text_color(*(DEEP if ci == 0 else TEXT))
                if ci == 0:
                    self.set_font("DJ", "B", 9.5)
                else:
                    self.set_font("DJ", "", 9.5)
                self.multi_cell(w, rh, "", border=0, fill=fill)  # bg
                self.set_xy(x0 + 1.5, y0 + 1)
                self.multi_cell(w - 3, 5, str(val))
                x0 += w
            self.set_y(y0 + rh)
        self.ln(2)


def build(title, subtitle, tagline, blocks, outfile):
    d = Doc(title)
    d.cover(subtitle, tagline)
    d.add_page()
    for b in blocks:
        kind = b[0]
        if kind == "h1": d.h1(b[1])
        elif kind == "h2": d.h2(b[1])
        elif kind == "p": d.para(b[1])
        elif kind == "bullets": d.bullets(b[1])
        elif kind == "steps": d.steps(b[1])
        elif kind == "callout": d.callout(b[1])
        elif kind == "table": d.table(b[1], b[2], b[3])
        elif kind == "page": d.add_page()
        elif kind == "ln": d.ln(b[1])
    d.output(outfile)
    print("saved", outfile)


# ════════════════════════ CONTENT ════════════════════════
import docs_content as C   # content lives next door for readability

if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    for spec in C.DOCS:
        build(spec["title"], spec["subtitle"], spec["tagline"], spec["blocks"],
              os.path.join(ROOT, "docs", spec["file"]))
