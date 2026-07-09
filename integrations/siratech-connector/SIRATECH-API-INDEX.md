# Siratech HIS — API base-path reference

Distilled from the complete Siratech API index. **The base path prefix is the thing to get right** —
the same route name can 404 under the wrong base (this is what hid the doctor-note endpoint).

## Base service → URL prefix

| Service token (index) | URL prefix (connector) |
|---|---|
| `EMR_API` | `/emr-api/api/v1` |
| `EMR_Core_API` | `/emr-core-api/api/v1` |
| `Patient_API` | `/patient-api/api/v1` |
| `Billing_API` | `/billing-api/api/v1` |
| `Investigation_API` | `/investigation-api/api/v1` |
| `Master_Suite_API` | `/master-settings-api/api/v1` |
| `Security_Suite_API` | `/security-api/api/v1` |

> Other services in the index (not currently used by the connector): ADT_API, Appointment_API, Blood_Bank_API, CSSD_API, Common_Shared_API, DischargSummary_API, Econnect_API, Final_Billing_Api, Finance_API, Ins_Approval_API, Personnel_API, PharmacyPanel_API, Pharmacy_API, Printer_Suite_API, QMatics_Common_API, RCM_PrinterSuite_API, Surgery_API, Task_API, Template_API

## Connector-relevant endpoints

| Verb | Base | Route |
|---|---|---|
| GET | `ADT_API` | `/IPEnquiry/PatBirthRegDetails?BedNo=${ve}` |
| GET | `Billing_API` | `/AvailedServiceInfo/GetRadiologyLog?DtlsPatBillingId=${f}` |
| POST | `Billing_API` | `/AvailedServiceInfo/GetRadiologyToken` |
| POST | `Billing_API` | `/AvailedServiceInfo/UpdateRadiologyArrivalStatus` |
| GET | `Billing_API` | `/BillCancel/CreditNotePageLoad?MachineName=${f.machineName}&UserId=${f.empId}&HospitalId=${f.hospitalId}` |
| POST | `Billing_API` | `/BillCancel/CreditNoteView` |
| POST | `Billing_API` | `/BillCancel/CreditNoteViewByID?genPatBillingId=${f.genPatBillingId}&visitMode=${f.visitMode}` |
| GET | `Billing_API` | `/Billing/GetResourceAppointment?MRNO=${f}&HospitalId=${I}` |
| POST | `Billing_API` | `/Billing/LoadAppointmentServices` |
| GET | `Billing_API` | `/Encounter/GetAppointmentPaymentInfo?ApptAllocationId=${c}&HospitalId=${n}` |
| GET | `Billing_API` | `/Encounter/PatientVisitType?Mrno=${n.mrno}&HospitalId=${n.hospitalId}&IsFindPage=${n.IsFindPage??!1}` |
| POST | `Blood_Bank_API` | `/BloodBank/BbMastCrossMatch` |
| POST | `Blood_Bank_API` | `/BloodBank/CrossMatchSave` |
| POST | `Blood_Bank_API` | `/BloodBank/CrossMatchStockinHand` |
| POST | `Blood_Bank_API` | `/BloodBank/CrossMatchingDelete` |
| POST | `Blood_Bank_API` | `/BloodBank/CrossMatchingSearch` |
| POST | `Blood_Bank_API` | `/BloodBank/GetBloodRequestComponent` |
| POST | `Blood_Bank_API` | `/BloodBank/LocationChangeSave` |
| POST | `Blood_Bank_API` | `/BloodBank/MasterValidation` |
| POST | `Blood_Bank_API` | `/BloodBank/TestResultView` |
| GET | `Blood_Bank_API` | `/BloodBank/TransfusionReceiveComponentLog?hospitalId=${te.hospitalId}&bbReceiveComponentID=${te.bbReceiveComponentID}` |
| POST | `Blood_Bank_API` | `/BloodBank/TransfusionRequestAcknowledgeSave` |
| GET | `Blood_Bank_API` | `/BloodBank/TransfusionRequestLog?hospitalId=${te.hospitalId}&bbMastRequestId=${te.bbMastRequestId}` |
| POST | `Blood_Bank_API` | `/BloodBank/TransfusionRequestSearch` |
| GET | `Blood_Bank_API` | `/BloodBank/ValidateComponentUnitNo?receivecomponentid=${te.receiveComponentId}&componentunitnumber=${te.componentUnitNo}&componentid=${te.componentId}&hospitalid=${te.hospitalId}` |
| GET | `Blood_Bank_API` | `/BloodBank/ValidateSampleNo?mrno=${te.mrno}&sampleNo=${te.lisSampleNo}` |
| POST | `Common_Shared_API` | `/CommonShared/CPOE/PDFPreview` |
| POST | `Common_Shared_API` | `/CommonShared/InsApproval/SaveEMRClinicalReport` |
| POST | `Common_Shared_API` | `/CommonShared/InsApproval/SavePharmacyEMRClinicalReport` |
| POST | `DischargSummary_API` | `/Leaves/GetDiagnosis` |
| POST | `EMR_API` | `/AllergyClinicalWarning/Allergy` |
| GET | `EMR_API` | `/AllergyClinicalWarning/DrugAllergyType/List` |
| POST | `EMR_API` | `/AllergyClinicalWarning/Patient/Warning/Reactions/List` |
| POST | `EMR_API` | `/AllergyClinicalWarning/Warning/Log` |
| GET | `EMR_API` | `/CPOEAdmin/BloodAdmin/VitalMes/Log?EmrBloodAdminId=${o}` |
| GET | `EMR_API` | `/CPOEAdmin/VitalSign` |
| GET | `EMR_API` | `/CPOEAdmin/VitalSignData?EmrPatBloodAdminId=${o}` |
| GET | `EMR_API` | `/Clinicalreport/Category` |
| POST | `EMR_API` | `/Clinicalreport/DiabeticInfusion` |
| POST | `EMR_API` | `/Clinicalreport/DiabeticSubcutaneous` |
| POST | `EMR_API` | `/Clinicalreport/Laboratory` |
| POST | `EMR_API` | `/Clinicalreport/Medicine` |
| POST | `EMR_API` | `/Clinicalreport/Vitals` |
| POST | `EMR_API` | `/Diagnosis/Details` |
| POST | `EMR_API` | `/Diagnosis/FetchDiagnosisValidation` |
| POST | `EMR_API` | `/Diagnosis/FetchDischargeRecommendationDetails` |
| GET | `EMR_API` | `/Diagnosis/FetchPatDiagnosisByPatFinEncounter?PatFinEncounterId=${o}\n      &EmrProviderVisitId=${m}&ReconciliationType=${M}` |
| POST | `EMR_API` | `/Diagnosis/FetchPatientAdmissionDepDetails` |
| POST | `EMR_API` | `/Diagnosis/FetchPatientAdmissionDetails` |
| POST | `EMR_API` | `/Diagnosis/FetchPatientAdmissionEmpDetails` |
| GET | `EMR_API` | `/Diagnosis/GetActiveDiagnosis/${o}/${m}` |
| POST | `EMR_API` | `/Diagnosis/GetAll` |
| POST | `EMR_API` | `/Diagnosis/Mast` |
| GET | `EMR_API` | `/Diagnosis/Patient/${o}?PatFinEncounterId=${M}` |
| GET | `EMR_API` | `/Diagnosis/Patient/Master` |
| POST | `EMR_API` | `/Diagnosis/PatientProblemlist` |
| POST | `EMR_API` | `/Diagnosis/PatientProblemlistLog` |
| POST | `EMR_API` | `/Diagnosis/SaveIcdReconciliation` |
| POST | `EMR_API` | `/Diagnosis/WebLink` |
| PUT | `EMR_API` | `/Diagnosis/problemlist/update` |
| POST | `EMR_API` | `/EMR/Allergies/ClinicalWarnings` |
| POST | `EMR_API` | `/EMR/BirthNote/List` |
| POST | `EMR_API` | `/EMR/EwsActionTaken/Vitals/Create` |
| GET | `EMR_API` | `/EMR/FetchBirthNoteMotherDetails?Mrno=${o}` |
| POST | `EMR_API` | `/EMR/FetchRadiologyDetails` |
| POST | `EMR_API` | `/EMR/FetchRadiologyImage` |
| POST | `EMR_API` | `/EMR/FetchRadiologyPdf` |
| POST | `EMR_API` | `/EMR/FetchRadiologyReport` |
| POST | `EMR_API` | `/EMR/SmartNoteSuggestions` |
| PUT | `EMR_API` | `/EMR/UpdateDrugAllergy` |
| POST | `EMR_API` | `/EMRMenu/AvaliableSmartNotes/byFieldId` |
| PUT | `EMR_API` | `/EMRMenu/Note/Edit ` |
| POST | `EMR_API` | `/EMRMenu/Notes/Remove ` |
| POST | `EMR_API` | `/EMRMenu/Notes/Save ` |
| POST | `EMR_API` | `/EMRMenu/ViewDiagnosisDetails` |
| POST | `EMR_API` | `/NurseProgressNotes/FetchChecklistDetails` |
| POST | `EMR_API` | `/PeriOperativeRecords/PreOpMedicines/HtmlPreview` |
| POST | `EMR_API` | `/Visits/Addendum/List` |
| DELETE | `EMR_API` | `/Visits/Addendum/Remove?emrPatAddendumId=${o}` |
| POST | `EMR_API` | `/Visits/Addendum/Save` |
| PUT | `EMR_API` | `/Visits/Addendum/Update` |
| POST | `EMR_API` | `/Visits/CarePlan/Template` |
| POST | `EMR_API` | `/Visits/CounterSign/List` |
| POST | `EMR_API` | `/Visits/CounterSign/Save` |
| POST | `EMR_API` | `/Visits/EWSActionTaken/List` |
| POST | `EMR_API` | `/Visits/List` |
| POST | `EMR_API` | `/VitalSign/ApacheLog` |
| POST | `EMR_API` | `/VitalSign/ApacheScore` |
| POST | `EMR_API` | `/VitalSign/ApacheScore/List` |
| POST | `EMR_API` | `/VitalSign/Create` |
| POST | `EMR_API` | `/VitalSign/Diluent` |
| GET | `EMR_API` | `/VitalSign/GrowthChart/Axis?EmrPatMastGrowthChartId=${n}` |
| POST | `EMR_API` | `/VitalSign/GrowthChart/SeriesPercentile` |
| POST | `EMR_API` | `/VitalSign/GrowthChart/Vital` |
| POST | `EMR_API` | `/VitalSign/IntakeOutput` |
| POST | `EMR_API` | `/VitalSign/IntakeOutput/VitalList` |
| POST | `EMR_API` | `/VitalSign/List` |
| POST | `EMR_API` | `/VitalSign/Log/ByMrno` |
| POST | `EMR_API` | `/VitalSign/Log/ByVsPhysID` |
| POST | `EMR_API` | `/VitalSign/Log/List` |
| POST | `EMR_API` | `/VitalSign/PatientCondition/List` |
| POST | `EMR_API` | `/VitalSign/PatientConditionLoad` |
| POST | `EMR_API` | `/VitalSign/Remove` |
| POST | `EMR_API` | `/VitalSign/Summary` |
| PUT | `EMR_API` | `/VitalSign/Update` |
| POST | `EMR_API` | `/VitalSign/VitalMachineReport/List` |
| POST | `EMR_API` | `/VitalSign/VitalSeverity` |
| POST | `EMR_API` | `/VitalSign/VitalsTempLoad` |
| POST | `EMR_Core_API` | `/EMRCore/CPOE/OrderDetails/ProviderVisitId` |
| POST | `EMR_Core_API` | `/EMRCore/CPOE/PDFPreview` |
| POST | `EMR_Core_API` | `/EMRCore/CPOEPreview` |
| POST | `EMR_Core_API` | `/EMRCore/CheckListPDFPreview` |
| POST | `EMR_Core_API` | `/EMRCore/ClinicalSummaryPDFPreview` |
| POST | `EMR_Core_API` | `/EMRCore/ClinicalSummaryPreview` |
| POST | `EMR_Core_API` | `/EMRCore/CommonPDFPreview` |
| POST | `EMR_Core_API` | `/EMRCore/DeleteDiagnosisIcd` |
| POST | `EMR_Core_API` | `/EMRCore/DiagnosisPreview` |
| POST | `EMR_Core_API` | `/EMRCore/EmrHtmlPreview` |
| POST | `EMR_Core_API` | `/EMRCore/EmrNoteLogPreview` |
| POST | `EMR_Core_API` | `/EMRCore/HandOffPreview` |
| POST | `EMR_Core_API` | `/EMRCore/HistoryPreview` |
| POST | `EMR_Core_API` | `/EMRCore/Note` |
| POST | `EMR_Core_API` | `/EMRCore/Note/V2` |
| POST | `EMR_Core_API` | `/EMRCore/NurseCheckListPreview` |
| POST | `EMR_Core_API` | `/EMRCore/NursingCarePlan/Preview` |
| GET | `EMR_Core_API` | `/EMRCore/PatHealthLiteracyScalePreview?mrno=${o}` |
| GET | `EMR_Core_API` | `/ICD/GetDiagnosisPreviewDetails?encounterId=${n}` |
| GET | `Final_Billing_Api` | `/FinalBilling/GetEMRProviderVisitId?PatFinEncounterId=${v}` |
| GET | `Ins_Approval_API` | `/InsuranceApproval/EMRNote/Exist?mrno=${oe}&hospitalId=${ft}` |
| POST | `Investigation_API` | `/ResultEntry/GetTemplateMasterData` |
| POST | `Investigation_API` | `/ResultEntry/GetTemplateTestResultDetails` |
| GET | `Master_Suite_API` | `/Emr/AllDiagnosisNotify` |
| GET | `Master_Suite_API` | `/Emr/FetchAllDiagnosisNotifyIcd` |
| GET | `Master_Suite_API` | `/Emr/FetchMappedDiagnosisDetails?IcdCode=${i}` |
| POST | `Master_Suite_API` | `/Emr/SaveDiagnosisNotifyMapping` |
| POST | `Master_Suite_API` | `/Emr/VitalCategory/ById` |
| POST | `Master_Suite_API` | `/Emr/VitalCategory/Save` |
| GET | `Master_Suite_API` | `/Emr/VitalSignCategory/AllData` |
| POST | `Master_Suite_API` | `/Emr/VitalSignCategory/SubDetails` |
| GET | `Master_Suite_API` | `/Emr/VitalSignMaster/AllDetails?LookupType=${i}&HospitalId=${r}` |
| POST | `Master_Suite_API` | `/Emr/VitalSignMaster/ById` |
| GET | `Master_Suite_API` | `/Emr/VitalSignMaster/HL7ChannelDetails?hospitalId=${i}` |
| GET | `Master_Suite_API` | `/Emr/VitalSignMaster/InitialData` |
| POST | `Master_Suite_API` | `/Emr/VitalSignMaster/Save` |
| POST | `Master_Suite_API` | `/Emr/VitalSignMaster/SubDetails` |
| GET | `Master_Suite_API` | `/Emr/VitalSignTemplates/ById?emrLookupId=${i}` |
| POST | `Master_Suite_API` | `/Emr/VitalSignTemplates/Save` |
| DELETE | `Master_Suite_API` | `/InfectionControl/DeleteICGeneralSettings?icGeneralSettingsId=${i}` |
| GET | `Master_Suite_API` | `/InfectionControl/GetICGeneralSettings` |
| GET | `Master_Suite_API` | `/InfectionControl/GetICServices?Type=${i}` |
| POST | `Master_Suite_API` | `/InfectionControl/GetLookupDetails?LookupTypes=${i}` |
| POST | `Master_Suite_API` | `/InfectionControl/InsertICGeneralSettings` |
| POST | `Master_Suite_API` | `/InfectionControl/UpdateICGeneralSettings` |
| GET | `Patient_API` | `/HomeHealth/GetHomeHealthRequestNoteDetails?requestId=${f}` |
| POST | `Patient_API` | `/HomeHealth/SaveHomeHealthRequestNote` |
| GET | `Patient_API` | `/Patient/BirthReg/History?mrNo=${n}&hospitalId=${c}&visitNo=${y}&mode=${Z}` |
| POST | `Patient_API` | `/Patient/PatientBannerInfo` |
| POST | `Patient_API` | `/Patient/StickyNotes` |
| POST | `Patient_API` | `/Patient/StickyNotes/Create` |
| DELETE | `Patient_API` | `/Patient/StickyNotes/Delete?GenStickyNoteId=${o}` |
| PUT | `Patient_API` | `/Patient/StickyNotes/Update` |
| POST | `Patient_API` | `/VitalSign/Details/List/ByDate` |
| POST | `Printer_Suite_API` | `/EMR/ClinicalSummaryPreview` |
| POST | `Printer_Suite_API` | `/EMR/EMR/VisitDetails` |
| POST | `Printer_Suite_API` | `/EMR/MedicineTacking/PDFPreview` |
| POST | `Printer_Suite_API` | `/FO/CreditNoteViewPrint` |
| POST | `Printer_Suite_API` | `/FO/InsApproval/PreviewClaimForm` |
| POST | `Printer_Suite_API` | `/FO/PharmacyReq/PreviewClaimForm` |
| POST | `RCM_PrinterSuite_API` | `/InvoicePrint/VisitWisePrint` |
| POST | `Surgery_API` | `/Surgery/NoteLog` |
| POST | `Surgery_API` | `/Surgery/OTMastScheduleORNote` |
| POST | `Surgery_API` | `/Surgery/SaveSurgeryNoteCounterSign` |
| POST | `Surgery_API` | `/Surgery/SurgeryAppointmentAuthorized` |
| POST | `Template_API` | `/TemplateMaster/FetchTemplateVisitType` |
