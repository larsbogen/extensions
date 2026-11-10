"""Make a 60-page synthetic pilot using Pillow, ReportLab and a macOS font."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

target = Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=False)
root = target / "import"
for folder in ["Notatbøker", "Kommenterte", "Originaler"]:
    (root / folder).mkdir(parents=True)
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Italic.ttf", 64)
notebooks = ["Møtenotater", "Planmøte"]
editions = ["Arbeidskrav", "Emnebeskrivelse v1", "Emnebeskrivelse v2", "Emnebeskrivelse v3"]
# Known comment locations and queries defined independently of OCR and ranking.
cases = [
    (0, 2, "ekstern sensor", "ekstern sensor", "ink"), (0, 6, "romfordeling", "romfordeling", "ink"),
    (0, 8, "praksisavtale", "praksisavtale", "all"), (1, 1, "notelesing", "notelesing", "ink"),
    (1, 3, "samspill", "samspill", "all"), (1, 5, "opptaksprøve", "opptaksprøve", "ink"),
    (1, 8, "arbeidsgruppe", "arbeidsgruppe", "ink"), (2, 2, "avklar ansvar", "MUR202", "all"),
    (2, 4, "MUR107", "MUR107", "ink"), (2, 7, "ensemble", "ensemble", "ink"),
    (2, 9, "følg opp", "MUR209", "all"), (2, 10, "øvingstid", "øvingstid", "all"),
    (3, 1, "ny vurdering", "MUR101", "all"), (3, 3, "bibliotek", "bibliotek", "ink"),
    (3, 8, "ønsker møte", "MUR108", "all"), (4, 4, "må avklares", "MUR104", "all"),
    (4, 5, "sensorrapport", "sensorrapport", "ink"), (4, 7, "høstsemester", "MUR107", "all"),
    (5, 2, "klaverprøve", "MUR102", "all"), (5, 10, "frist mandag", "frist mandag", "ink"),
]
by_page = {(d, p): (s, q, m) for d, p, s, q, m in cases}
queries = []
for d, name in enumerate(notebooks + editions):
    notebook = d < 2
    relative = ("Notatbøker/" if notebook else "Kommenterte/") + name + ".pdf"
    export = canvas.Canvas(str(root / relative), pagesize=(500, 590), invariant=True)
    original = None if notebook else canvas.Canvas(str(root / "Originaler" / (name + ".pdf")), pagesize=(500, 590), invariant=True)
    for page in range(1, 11):
        code = "MUR" + str((200 if d == 2 else 100) + page)
        for c in [export] + ([original] if original else []):
            if not notebook:
                c.setFont("Helvetica-Bold", 16)
                c.drawString(30, 518, name)
                c.setFont("Helvetica", 13)
                c.drawString(30, 357, f"Arbeidskrav og vurdering for {code}.")
                c.drawString(30, 342, "Saken behandles ved neste møte.")
                c.drawString(30, 150, "Lydlaboratoriet har egne frister.")
                c.drawString(30, 45, f"Emneplan, fysisk side {page}.")
        if (d, page) in by_page:
            label, query, mode = by_page[(d, page)]
            left, top, right, bottom = font.getbbox(label)
            width, height = right - left, bottom - top
            im = Image.new("RGB", (width + 8, height + 8), "white")
            ImageDraw.Draw(im).text((4 - left, 4 - top), label, font=font, fill="black")
            x, y, scale = (75 if notebook else 286), 349, 0.25
            export.drawImage(ImageReader(im), x, y, im.width * scale, im.height * scale)
            queries.append({"query": query, "mode": mode, "expected": {"document": relative, "page": page,
                            "rect": [x + 4*scale, y + 4*scale, width*scale, height*scale]}})
        export.showPage()
        if original:
            original.showPage()
    export.save()
    if original:
        original.save()
for query, mode in [("MUR109", "all"), ("MUR201", "all"), ("MUR103", "ink"), ("MUR102", "ink"),
                    ("MUR1070", "all"), ("Lydlaboratoriet", "all"), ("sensorstipend", "ink"),
                    ("MUR207", "ink"), ("trompeteksamen", "all"), ("frist fredag", "ink")]:
    queries.append({"query": query, "mode": mode, "expected": None})
gold = {"holdout": {"notebook": "Notatbøker/Planmøte.pdf", "versions":
        ["Kommenterte/" + name + ".pdf" for name in editions[1:]]}, "queries": queries}
(target / "fasit.json").write_text(json.dumps(gold, ensure_ascii=False, indent=2) + "\n")
