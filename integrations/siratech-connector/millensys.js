// ── MILLENSYS MiClinic (RadCare Health) client — READ-ONLY ────────────────────
//
// Cross-system MRI/CT match: given a Siratech patient's NATIONAL ID and the ORDER
// DATE, find the matching report in RadCare's MILLENSYS MiClinic (which Meena's own
// Siratech/DePACS stack does not carry). Every endpoint here was confirmed live
// against the MiClinic SPA — see MILLENSYS-INTEGRATION-MAP.md. All calls are reads
// (patient search + grid reads); nothing is written.
//
// The confirmed chain (national ID → report):
//   POST CommonPages/GetPatients        SsnNumber=<nid> & PSearchCriteria=4   → PatientId
//   POST CommonPages/EncouterDataGetById  patid=<PatientId> & branchid=0       → EncounterId
//   GET  CommonPages/EncouterServicesId?EncounterId=<id>                       → services (AccountServiceId, ClinicName, ServiceDate, ClinicReportsCount, VisitId)
//   GET  PatientSummaryPrintSetting/GetResaultsGridData?PatientId=&VisitId=&EncounterId=  → ClinicalReportId, ReportName, FilePath, ReportStatusDate
//
// Auth: the SPA is session-based (no bearer). Supply a logged-in cookie via
// MILLENSYS_COOKIE (copy from an authenticated MiClinic tab). Base via MILLENSYS_BASE
// (default the RadCare host). Without a cookie every call throws a clear error.

const BASE = (process.env.MILLENSYS_BASE || 'https://mill.radcarehealth.com/MILLENSYS/MiClinic').replace(/\/+$/, '');
const COOKIE = process.env.MILLENSYS_COOKIE || '';
// Match window: a report belongs to an order only if it is dated ON/AFTER the order,
// within this many days after it (a report is produced after the exam, never before).
const FORWARD_DAYS = Number(process.env.MILLENSYS_FORWARD_DAYS || 120);

function configured() { return !!COOKIE; }

// MILLENSYS serialises dates as "/Date(1783788632950)/" (ms since epoch, sometimes
// with a +offset). Parse to epoch ms, or null.
function parseMsDate(v) {
  if (v == null) return null;
  const m = String(v).match(/\/Date\((-?\d+)([+-]\d+)?\)\//);
  if (m) return Number(m[1]);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const MOD_RE = /\b(MRI|MR|CT|CAT\s*SCAN)\b/i;
function isMrOrCt(...vals) { return vals.some((v) => MOD_RE.test(String(v || ''))); }

async function call(method, path, { query, form } = {}) {
  if (!COOKIE) throw new Error('MILLENSYS_COOKIE is not set — supply a logged-in MiClinic session cookie.');
  let url = `${BASE}${path}`;
  if (query) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(query).toString();
  const headers = { 'X-Requested-With': 'XMLHttpRequest', Cookie: COOKIE, Accept: 'application/json, text/plain, */*' };
  const opts = { method, headers };
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) { /* HTML/plain */ }
  return { status: r.status, json, text };
}

const KENDO = { sort: '', page: '1', pageSize: '50', group: '', filter: '' };
const rows = (r) => (r && r.json && (r.json.Data || r.json.data)) || [];

// national ID / Iqama → patient row(s). Exact match (PSearchCriteria=4).
async function searchByNationalId(nid) {
  const ssn = String(nid || '').trim();
  if (!ssn) return [];
  const r = await call('POST', '/CommonPages/GetPatients', { form: {
    ...KENDO, SsnNumber: ssn, PSearchCriteria: '4',
    PatientCode: '', PatientName: '', MRN: '', PatientDateBirth: '', Gender: '',
    PersonalMobileNumber: '', HomePhoneNumber: '', TypeOfPatientName: '', GivenName: '', MiddleName: '', FamilyName: '',
  } });
  return rows(r);
}

async function encountersFor(patientId) {
  const r = await call('POST', '/CommonPages/EncouterDataGetById', { form: { ...KENDO, patid: String(patientId), branchid: '0' } });
  return rows(r);
}

async function servicesFor(encounterId) {
  const r = await call('GET', '/CommonPages/EncouterServicesId', { query: { ...KENDO, EncounterId: String(encounterId) } });
  return rows(r);
}

// Reports filed for a patient/visit/encounter (ClinicalReportId, ReportName, FilePath, ReportStatusDate).
async function reportsFor({ patientId, visitId, encounterId }) {
  const r = await call('GET', '/PatientSummaryPrintSetting/GetResaultsGridData', { query: {
    ...KENDO, PatientId: String(patientId), VisitId: String(visitId || 0), EncounterId: String(encounterId || 0),
  } });
  return rows(r);
}

// The whole match: national ID (+ optional Siratech order date/name) → matched MRI/CT
// report(s) in RadCare. A report qualifies only if dated ON/AFTER the order date
// (within FORWARD_DAYS). Returns a structured, strict result — it never guesses.
async function matchMriReport({ nationalId, orderDate, serviceName } = {}) {
  const orderMs = orderDate ? parseMsDate(orderDate) || Date.parse(orderDate) : null;
  const afterOrder = (ms) => {
    if (!Number.isFinite(orderMs) || !Number.isFinite(ms)) return null; // unknown → can't judge on date
    const days = (ms - orderMs) / 864e5;
    return days >= -0.5 && days <= FORWARD_DAYS;
  };

  const patients = await searchByNationalId(nationalId);
  if (!patients.length) return { decision: 'no_patient', nationalId, reason: 'no RadCare patient with this national ID' };
  const patient = patients[0];
  const patientId = patient.PatientId;

  const encounters = await encountersFor(patientId);
  const candidates = [];
  for (const enc of encounters) {
    const services = await servicesFor(enc.EncounterId);
    const mrct = services.filter((s) => isMrOrCt(s.ClinicName, s.ServiceName));
    if (!mrct.length) continue;
    // Reports for this encounter's visit(s). Services carry the real VisitId.
    const seenVisits = new Set();
    const reps = [];
    for (const s of mrct) {
      const vid = s.VisitId || enc.VisitId || 0;
      if (seenVisits.has(vid)) continue; seenVisits.add(vid);
      reps.push(...await reportsFor({ patientId, visitId: vid, encounterId: enc.EncounterId }));
    }
    for (const s of mrct) {
      const rep = reps.find((x) => String(x.AccountServiceId) === String(s.AccountServiceId));
      const repMs = rep ? parseMsDate(rep.ReportStatusDate) : null;
      const svcMs = parseMsDate(s.ServiceDate);
      const dateMs = repMs != null ? repMs : svcMs;
      candidates.push({
        encounterId: enc.EncounterId,
        accountServiceId: s.AccountServiceId,
        serviceName: s.ServiceName, clinic: s.ClinicName,
        serviceDate: svcMs, reportDate: repMs,
        hasReport: (s.ClinicReportsCount || 0) > 0 || !!rep,
        clinicalReportId: rep ? rep.ClinicalReportId : null,
        reportName: rep ? rep.ReportName : null,
        filePath: rep ? rep.FilePath : null,
        afterOrder: afterOrder(dateMs),
      });
    }
  }

  // Prefer a candidate that HAS a report AND is dated after the order. If order date is
  // unknown, fall back to any MRI/CT with a report.
  const withReport = candidates.filter((c) => c.hasReport);
  const afterOk = withReport.filter((c) => c.afterOrder === true);
  const chosen = (afterOk[0] || (orderMs == null ? withReport[0] : null)) || null;

  return {
    decision: chosen ? 'match' : (withReport.length ? 'report_before_order' : (candidates.length ? 'mrct_no_report' : 'no_mrct')),
    nationalId,
    patient: { patientId, patientCode: patient.PatientCode, mrn: patient.MRN, encounters: encounters.length },
    matched: chosen,
    candidates,
  };
}

module.exports = {
  configured, BASE, FORWARD_DAYS,
  parseMsDate, isMrOrCt,
  searchByNationalId, encountersFor, servicesFor, reportsFor, matchMriReport,
};
