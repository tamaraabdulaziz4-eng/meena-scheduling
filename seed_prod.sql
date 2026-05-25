-- Seed production Neon DB with staff and user accounts
-- Safe to re-run: uses ON CONFLICT DO NOTHING

-- Staff (51 members)
INSERT INTO scheduling.staff (branch_id, name, speciality, is_cross_branch, active) VALUES
-- NEST 1
(1, 'Wafa Assiri',        ARRAY['General'],              false, true),
(1, 'Cheryl',             ARRAY['General'],              false, true),
(1, 'Muhanned',           ARRAY['General'],              true,  true),
(1, 'Elham',              ARRAY['General'],              false, true),
(1, 'Aminah',             ARRAY['General'],              false, true),
(1, 'Mnayer',             ARRAY['General'],              false, true),
(1, 'Tagreed',            ARRAY['Ultrasound'],           false, true),
(1, 'Sadeem',             ARRAY['Ultrasound'],           false, true),
(1, 'Rawan',              ARRAY['Ultrasound'],           false, true),
(1, 'Alanood',            ARRAY['Ultrasound'],           false, true),
(1, 'Alnoud Alrashdi',    ARRAY['Ultrasound'],           false, true),
-- NEST 2
(2, 'Badrih',             ARRAY['General'],              false, true),
(2, 'Dalal',              ARRAY['General'],              false, true),
(2, 'Wedad',              ARRAY['General'],              false, true),
(2, 'Layan',              ARRAY['General'],              true,  true),
(2, 'Fatin',              ARRAY['General'],              false, true),
(2, 'Naif',               ARRAY['General'],              false, true),
(2, 'Mohammed Batt',      ARRAY['General'],              true,  true),
(2, 'Alhanouf Bin Ammar', ARRAY['Ultrasound'],           false, true),
(2, 'Hajer AL Mutiri',    ARRAY['Ultrasound'],           false, true),
(2, 'Joy',                ARRAY['Ultrasound'],           false, true),
(2, 'Alhanouf Alazmi',    ARRAY['Ultrasound'],           false, true),
-- NEST 3
(3, 'Duaa',               ARRAY['General'],              false, true),
(3, 'Rawan Alharbi',      ARRAY['General'],              false, true),
(3, 'Nourah',             ARRAY['General'],              false, true),
(3, 'Abdulaziz Alanazi',  ARRAY['General'],              false, true),
(3, 'Bushra Alqahani',    ARRAY['General'],              false, true),
(3, 'Alma Tolentino',     ARRAY['Ultrasound'],           false, true),
(3, 'Manar',              ARRAY['Ultrasound'],           false, true),
(3, 'Qamraa',             ARRAY['Ultrasound'],           false, true),
(3, 'Reem Alharbi',       ARRAY['Ultrasound'],           false, true),
-- NEST 4
(4, 'Sara Halawani',      ARRAY['General'],              false, true),
(4, 'Arob',               ARRAY['General'],              false, true),
(4, 'Rana',               ARRAY['Ultrasound'],           false, true),
(4, 'Aeshah',             ARRAY['Ultrasound'],           false, true),
(4, 'Taif',               ARRAY['Ultrasound'],           false, true),
(4, 'Alaa',               ARRAY['Ultrasound'],           false, true),
-- NEST 6
(5, 'Mohammed',           ARRAY['General'],              true,  true),
(5, 'Naif Almutari',      ARRAY['General'],              false, true),
(5, 'Ruba',               ARRAY['General'],              false, true),
(5, 'Shahad',             ARRAY['General'],              false, true),
(5, 'Wedad N6',           ARRAY['General'],              false, true),
(5, 'Layan N6',           ARRAY['General'],              false, true),
(5, 'Dalal N6',           ARRAY['General'],              false, true),
(5, 'Rana N6',            ARRAY['Ultrasound'],           false, true),
(5, 'Meyan',              ARRAY['Ultrasound'],           false, true),
(5, 'Alanoud N6',         ARRAY['Ultrasound'],           false, true),
(5, 'Hajer N6',           ARRAY['Ultrasound'],           false, true),
(5, 'Alma N6',            ARRAY['Ultrasound'],           false, true),
(5, 'Naif',               ARRAY['General'],              false, true),
-- Al-Jubail (Y5)
(6, 'Manal Salem',        ARRAY['General','Ultrasound'], false, true)
;

-- User accounts (team leaders + extra admins)
-- Passwords are bcrypt hashes from local DB (same plaintext passwords)
INSERT INTO scheduling.users (username, password, role, branch_id) VALUES
('wafa',      '$2b$12$yYhS0vhqm6xxSf1t5hayRunmC3LGspVpDzP5MI3Q8/RAMBMkcu8Sa', 'admin', 1),
('hajer',     '$2b$12$nDv2ibMPhiMNZxQDSnMTMuIZUxDsszrhERl8lkgANUsyZZCJdQGwO', 'admin', 2),
('abdulaziz', '$2b$12$7cTl6uuRcD7089MD45NViu9nPOmAZs6H5BmRQx0Qgco.5EDg7MJEm', 'admin', 3),
('sara',      '$2b$12$EoW01d9lE993zuROUT1aeezpVdJGZhnZaTPoG5RHWpooOZ187fU.S',  'admin', 4),
('mohammed',  '$2b$12$hmCx1x0/rB7H5pq.8UzypeIEr.p7NPc8ZtAkG9otzKbI8TZSnFBjG', 'admin', 5),
('manal',     '$2b$12$1j8u4rbmWsBOWLCrXbQP8eVFNPGmxrLS/jcfrqeqvh1KEmYp0FmQC', 'admin', 6),
('mbatt',     '$2b$12$TTvmebfyA/OKqUeEGBU5Su3RsECucRGrJq31UhvHQV0WGWEfI8IPa', 'admin', NULL),
('khalid',    '$2b$12$WwNO/dnwtDR8C/.0SDJPV.OH/QPPHHHHIre4Ku0G9GR14wBhlg4A2', 'superadmin', NULL)
ON CONFLICT (username) DO NOTHING;
