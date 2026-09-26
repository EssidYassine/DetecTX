"""Génération de rapports PDF (fpdf2), à partir des données réelles."""

from datetime import datetime, timezone

from fpdf import FPDF
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import alerts as alerts_svc
from app.services import events as events_svc

_ACCENT = (13, 148, 136)
_DARK = (15, 23, 32)
_MUTED = (110, 120, 135)
_SEV_COLOR = {
    "critical": (225, 29, 72),
    "high": (217, 119, 6),
    "medium": (13, 148, 136),
    "low": (110, 120, 135),
}


def _txt(s: str) -> str:
    """Rend une chaîne compatible latin-1 (police cœur fpdf)."""
    return (s or "").encode("latin-1", "replace").decode("latin-1")


class _Report(FPDF):
    def header(self) -> None:
        self.set_fill_color(*_DARK)
        self.rect(0, 0, 210, 22, "F")
        self.set_xy(12, 6)
        self.set_font("Helvetica", "B", 16)
        self.set_text_color(255, 255, 255)
        self.cell(0, 10, "DeTecTX  -  Rapport de securite")
        self.ln(20)

    def footer(self) -> None:
        self.set_y(-12)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*_MUTED)
        self.cell(0, 8, _txt(f"DeTecTX - Genere le {datetime.now():%Y-%m-%d %H:%M} - page {self.page_no()}"))

    def section(self, title: str) -> None:
        self.ln(4)
        self.set_font("Helvetica", "B", 12)
        self.set_text_color(*_ACCENT)
        self.cell(0, 8, _txt(title), new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(*_ACCENT)
        self.line(12, self.get_y(), 60, self.get_y())
        self.ln(3)
        self.set_text_color(*_DARK)


async def build_summary_pdf(session: AsyncSession) -> bytes:
    try:
        estats = await events_svc.events_stats()
    except Exception:  # noqa: BLE001
        estats = None
    astats = await alerts_svc.alerts_stats(session)
    top = (await alerts_svc.list_alerts(session, limit=12)).items

    pdf = _Report()
    pdf.set_auto_page_break(True, margin=18)
    pdf.add_page()
    pdf.set_left_margin(12)
    pdf.set_right_margin(12)

    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(*_MUTED)
    pdf.cell(0, 6, _txt(f"Poste surveille : local  -  {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}"),
             new_x="LMARGIN", new_y="NEXT")

    # KPIs
    pdf.section("Synthese")
    pdf.set_font("Helvetica", "", 11)
    pdf.set_text_color(*_DARK)
    ev_total = estats.total if estats else "-"
    ev_24 = estats.last_24h if estats else "-"
    for label, val in [
        ("Evenements collectes", ev_total),
        ("Evenements (24h)", ev_24),
        ("Alertes totales", astats.total),
        ("Alertes critiques", astats.by_severity.get("critical", 0)),
    ]:
        pdf.cell(70, 7, _txt(label))
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 7, str(val), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)

    # Alertes par severite
    pdf.section("Alertes par severite")
    pdf.set_font("Helvetica", "", 10)
    for sev in ("critical", "high", "medium", "low"):
        n = astats.by_severity.get(sev, 0)
        pdf.set_text_color(*_SEV_COLOR[sev])
        pdf.cell(40, 6, _txt(sev.capitalize()))
        pdf.set_text_color(*_DARK)
        pdf.cell(0, 6, str(n), new_x="LMARGIN", new_y="NEXT")

    # Techniques MITRE
    if astats.by_mitre:
        pdf.section("Techniques MITRE ATT&CK detectees")
        pdf.set_font("Helvetica", "", 10)
        for tech, n in sorted(astats.by_mitre.items(), key=lambda x: -x[1]):
            pdf.cell(0, 6, _txt(f"{tech}  ({n} alerte(s))"), new_x="LMARGIN", new_y="NEXT")

    # Top alertes
    pdf.section("Principales alertes")
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_fill_color(238, 242, 247)
    pdf.cell(22, 7, "Severite", fill=True)
    pdf.cell(26, 7, "MITRE", fill=True)
    pdf.cell(0, 7, "Regle", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    for a in top:
        pdf.set_text_color(*_SEV_COLOR.get(a.severity, _DARK))
        pdf.cell(22, 6, _txt(a.severity))
        pdf.set_text_color(*_DARK)
        pdf.cell(26, 6, _txt(a.mitre or "-"))
        pdf.cell(0, 6, _txt(a.rule_title[:80]), new_x="LMARGIN", new_y="NEXT")

    out = pdf.output()
    return bytes(out)
