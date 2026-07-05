// Windows one-file entry for the MWL probe — hospital defaults baked in so a
// non-technical operator can run it with zero configuration:
//   node mwl-probe-win.js            → queries DMWL_AE @ 10.0.73.56:104, today only
//   node mwl-probe-win.js CTN3       → same, presenting Calling AE "CTN3" (if the
//                                      broker only answers machines it knows)
// Built into a single self-contained file (no npm install on the hospital PC) with:
//   npx esbuild mwl-probe-win-entry.js --bundle --platform=node --outfile=mwl-probe-win.js
'use strict';
process.env.MWL_HOST = process.env.MWL_HOST || '10.0.73.56';
process.env.MWL_PORT = process.env.MWL_PORT || '104';
process.env.MWL_CALLED_AE = process.env.MWL_CALLED_AE || 'DMWL_AE';
process.env.MWL_DATE = process.env.MWL_DATE || 'TODAY';
if (process.argv[2]) process.env.MWL_CALLING_AE = process.argv[2];
// Quiet the DICOM library's wire logging so the operator sees only the report.
// (Set MWL_DEBUG=1 to keep the full association/PDU log for troubleshooting.)
if (process.env.MWL_DEBUG !== '1') {
  try { require('dcmjs-dimse').log.disableAll(); } catch (e) { /* best-effort */ }
}
require('./mwl-probe.js');
