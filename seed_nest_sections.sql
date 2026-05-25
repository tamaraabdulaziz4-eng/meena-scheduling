-- Sync nest_sections from local to Neon production
-- Truncate and re-insert all rows cleanly

TRUNCATE scheduling.nest_sections;

INSERT INTO scheduling.nest_sections (nest_key, section_name, staff, staff_db_names, allowed_shifts, coverage, exact_coverage) VALUES

('NEST1', 'General',
 ARRAY['WAFA','CHERYL','MUHANNED','ELHAM','AMINAH','MNAYER'],
 '{"WAFA": "Wafa Assiri", "ELHAM": "Elham", "AMINAH": "Aminah", "CHERYL": "Cheryl", "MNAYER": "Mnayer", "MUHANNED": "Muhanned"}',
 ARRAY['D','M','N','O','AL','SL'],
 '{"weekday": {"M": 1, "N": 1}, "weekend": {"M": 1, "N": 1}}',
 '{"N": 1}'),

('NEST1', 'US',
 ARRAY['RAWAN','ALANOOD','ALNOUD','TAGREED','SADEEM'],
 '{"RAWAN": "Rawan", "ALNOUD": "Alnoud Alrashdi", "SADEEM": "Sadeem", "ALANOOD": "Alanood", "TAGREED": "Tagreed"}',
 ARRAY['M','N','O','AL','SL'],
 '{"weekday": {"M": 1, "N": 1}, "weekend": {"M": 1, "N": 1}}',
 '{"N": 1}'),

('NEST2', 'General',
 ARRAY['BADRIH','DALAL','WEDAD','LAYAN','FATIN','NAIF','MOHAMMED_BATT'],
 '{"NAIF": "Naif", "DALAL": "Dalal", "FATIN": "Fatin", "LAYAN": "Layan", "WEDAD": "Wedad", "BADRIH": "Badrih", "MOHAMMED_BATT": "Mohammed Batt"}',
 ARRAY['M','N','N6','D1','Y3','O','AL','SL','OC'],
 '{"weekday": {"M": 1, "N": 1}, "weekend": {"M": 1, "N": 1}}',
 '{}'),

('NEST2', 'US',
 ARRAY['ALHANOUF_BIN_AMMAR','HAJER','JOY','ALHANOUF_ALAZMI'],
 '{"JOY": "Joy", "HAJER": "Hajer AL Mutiri", "ALHANOUF_ALAZMI": "Alhanouf Alazmi", "ALHANOUF_BIN_AMMAR": "Alhanouf Bin Ammar"}',
 ARRAY['D','D1','N6','O','AL','SL','OC'],
 '{"weekday": {"D": 1, "N6": 1}, "weekend": {"D": 1}}',
 '{}'),

('NEST3', 'General',
 ARRAY['DUAA','RAWAN','NOURAH','ABDULAZIZ','BUSHRA'],
 '{"DUAA": "Duaa", "RAWAN": "Rawan Alharbi", "BUSHRA": "Bushra Alqahani", "NOURAH": "Nourah", "ABDULAZIZ": "Abdulaziz Alanazi"}',
 ARRAY['M','N','A','O','AL','SL','OC'],
 '{"weekday": {"M": 1, "N": 1}, "weekend": {"M": 1, "N": 1}}',
 '{}'),

('NEST3', 'US',
 ARRAY['ALMA','MANAR','QAMRAA','REEM'],
 '{"ALMA": "Alma Tolentino", "REEM": "Reem Alharbi", "MANAR": "Manar", "QAMRAA": "Qamraa"}',
 ARRAY['D','D1','EV','N','A','O','AL','SL','OC'],
 '{"weekday": {"D": 1, "N": 1}, "weekend": {"D": 1}}',
 '{}'),

('NEST4', 'General',
 ARRAY['SARAH','AROB'],
 '{"AROB": "Arob", "SARAH": "Sara Halawani"}',
 ARRAY['D','EV','O','AL','SL','OC'],
 '{}',
 '{}'),

('NEST4', 'US',
 ARRAY['RANA','AESHAH','TAIF','ALAA'],
 '{"ALAA": "Alaa", "RANA": "Rana", "TAIF": "Taif", "AESHAH": "Aeshah"}',
 ARRAY['M','N','B','O','AL','SL','OC'],
 '{"weekday": {"M": 1, "N": 1}, "weekend": {"M": 1, "N": 1}}',
 '{}'),

('NEST6', 'General',
 ARRAY['MOHAMMED','NAIF','RUBA','SHAHAD','WEDAD','NAIF_ALMUTARI','LAYAN','DALAL'],
 '{"NAIF": "Naif", "RUBA": "Ruba", "DALAL": "Dalal N6", "LAYAN": "Layan N6", "WEDAD": "Wedad N6", "SHAHAD": "Shahad", "MOHAMMED": "Mohammed", "NAIF_ALMUTARI": "Naif Almutari"}',
 ARRAY['D','M','N','EV','Y3','O','AL','SL','OC'],
 '{"weekday": {"D": 1, "M": 1, "N": 1}, "weekend": {"M": 1, "N": 1}}',
 '{}'),

('NEST6', 'US',
 ARRAY['RANA','MEYAN','ALANOUD','HAJER','ALMA'],
 '{"ALMA": "Alma N6", "RANA": "Rana N6", "HAJER": "Hajer N6", "MEYAN": "Meyan", "ALANOUD": "Alanoud N6"}',
 ARRAY['A','B','C','D','M','N','O','AL','SL','OC'],
 '{"weekday": {"A": 1, "B": 1, "N": 1}, "weekend": {"A": 1, "B": 1}}',
 '{}'),

('Y5', 'General',
 ARRAY['MANAL'],
 '{"MANAL": "Manal Salem"}',
 ARRAY['A','O','OC','AL','SL'],
 '{}',
 '{}');
