// Master job list powering the programmatic /resume-examples/{slug} pages.
// Each entry carries genuinely unique content so pages aren't thin duplicates
// (the #1 reason programmatic SEO fails). Category enables hub cross-linking.

export interface JobData {
  slug: string;
  title: string;
  category: string;
  salary: string;        // rough global range for the intro
  demand: string;        // one line on market demand
  atsKeywords: string[]; // the exact terms ATS scans for this role
  skills: string[];      // hard + soft skills
  summary: string;       // an example professional summary
  bullets: string[];     // example quantified experience bullets
  certs: string[];       // relevant certifications
  mistake: string;       // a common resume mistake for this role
}

export const JOBS: JobData[] = [
  {
    slug: "software-engineer", title: "Software Engineer", category: "Technology",
    salary: "$95,000–$160,000 (SAR 180k–420k in KSA)",
    demand: "Among the most in-demand roles globally and a Vision 2030 priority in Saudi Arabia's tech sector.",
    atsKeywords: ["JavaScript", "Python", "React", "Node.js", "REST API", "SQL", "Git", "CI/CD", "AWS", "microservices", "Agile", "unit testing"],
    skills: ["System design", "Data structures & algorithms", "Cloud (AWS/Azure)", "Docker & Kubernetes", "Code review", "Problem-solving", "Cross-functional collaboration"],
    summary: "Software Engineer with 5+ years building scalable web applications in React and Node.js. Shipped features serving 100k+ users and cut API latency 35% through query optimization and caching.",
    bullets: ["Architected a microservices backend that scaled to 1M requests/day with 99.9% uptime", "Reduced page-load time 40% by code-splitting and lazy-loading the React front end", "Mentored 3 junior engineers and introduced a code-review process that cut production bugs 25%"],
    certs: ["AWS Certified Developer", "Oracle Certified Java Programmer", "Certified Kubernetes Application Developer (CKAD)"],
    mistake: "Listing every technology you've ever touched instead of the specific stack in the job posting — ATS ranks focused, keyword-matched resumes higher.",
  },
  {
    slug: "registered-nurse", title: "Registered Nurse", category: "Healthcare",
    salary: "$60,000–$95,000 (SAR 120k–260k in KSA)",
    demand: "Persistent global shortage; major hiring across Saudi hospitals and the Red Sea/NEOM health projects.",
    atsKeywords: ["patient care", "BLS", "ACLS", "EMR", "medication administration", "triage", "vital signs", "care plans", "HIPAA", "infection control"],
    skills: ["Patient assessment", "IV therapy", "Electronic Medical Records (EMR)", "Wound care", "Patient education", "Empathy", "Time management under pressure"],
    summary: "Registered Nurse with 6 years in acute-care settings, managing up to 8 patients per shift while maintaining a 98% patient-satisfaction score and zero medication errors.",
    bullets: ["Managed care for 8+ acute patients per shift, coordinating with physicians to improve discharge times 20%", "Trained 5 new nurses on EMR charting and infection-control protocols", "Reduced patient falls 30% by implementing a hourly-rounding checklist"],
    certs: ["BLS", "ACLS", "Registered Nurse (RN) License", "SCFHS classification (for KSA)"],
    mistake: "Omitting license numbers, certifications (BLS/ACLS), and the EMR systems you know — these are the exact terms healthcare ATS filters scan for.",
  },
  {
    slug: "accountant", title: "Accountant", category: "Finance",
    salary: "$55,000–$90,000 (SAR 100k–240k in KSA)",
    demand: "Steady demand across every industry; Saudi VAT and Zakat regulations increase need for qualified accountants.",
    atsKeywords: ["accounts payable", "accounts receivable", "general ledger", "reconciliation", "financial reporting", "GAAP", "IFRS", "Excel", "SAP", "QuickBooks", "VAT", "auditing"],
    skills: ["Financial statement preparation", "Month-end close", "Budgeting & forecasting", "Tax compliance (VAT/Zakat)", "ERP systems (SAP/Oracle)", "Attention to detail", "Analytical thinking"],
    summary: "Detail-oriented Accountant with 5 years managing full-cycle accounting for firms up to $20M revenue. Cut month-end close from 10 to 6 days and recovered $120k in mis-billed receivables.",
    bullets: ["Managed general ledger and reconciled 15+ accounts monthly with 100% accuracy", "Prepared IFRS-compliant financial statements and supported a clean external audit", "Automated AP workflow in SAP, reducing invoice-processing time 45%"],
    certs: ["CPA", "CMA", "ACCA", "SOCPA (for KSA)"],
    mistake: "Writing 'responsible for accounting' instead of quantifying — recruiters and ATS both reward numbers like '$20M revenue' or 'reduced close by 4 days'.",
  },
  {
    slug: "project-manager", title: "Project Manager", category: "Business",
    salary: "$80,000–$130,000 (SAR 180k–360k in KSA)",
    demand: "Critical across construction, IT, and Saudi giga-projects (NEOM, Qiddiya, Red Sea).",
    atsKeywords: ["project management", "Agile", "Scrum", "stakeholder management", "budget management", "risk management", "Gantt", "PMP", "JIRA", "scope", "deliverables", "KPIs"],
    skills: ["Project planning & scheduling", "Budget & resource management", "Risk mitigation", "Stakeholder communication", "Agile & Waterfall", "Leadership", "Negotiation"],
    summary: "PMP-certified Project Manager who has delivered 20+ projects up to $5M on time and under budget, leading cross-functional teams of up to 15 across IT and construction.",
    bullets: ["Delivered a $5M ERP rollout 2 weeks early and 8% under budget across 4 departments", "Cut project risk by building a mitigation register that reduced schedule slippage 30%", "Led a 15-person cross-functional team using Agile, improving on-time delivery from 70% to 95%"],
    certs: ["PMP", "PRINCE2", "Certified ScrumMaster (CSM)", "CAPM"],
    mistake: "Describing tasks instead of outcomes — lead with budgets managed, timelines hit, and team sizes, then quantify the result.",
  },
  {
    slug: "data-analyst", title: "Data Analyst", category: "Technology",
    salary: "$65,000–$110,000 (SAR 140k–320k in KSA)",
    demand: "Explosive demand as Saudi organizations pursue data-driven Vision 2030 transformation.",
    atsKeywords: ["SQL", "Python", "Excel", "Power BI", "Tableau", "data visualization", "data cleaning", "statistics", "dashboards", "ETL", "A/B testing", "reporting"],
    skills: ["SQL querying", "Data visualization (Power BI/Tableau)", "Python/pandas", "Statistical analysis", "Dashboard design", "Business acumen", "Storytelling with data"],
    summary: "Data Analyst with 4 years turning raw data into decisions using SQL, Python, and Power BI. Built dashboards that cut reporting time 60% and surfaced a churn driver that saved $200k/year.",
    bullets: ["Built 10+ automated Power BI dashboards, reducing manual reporting 60%", "Wrote complex SQL to analyze 5M+ rows and identify a churn driver worth $200k annually", "Ran A/B tests that lifted email conversion 18%"],
    certs: ["Google Data Analytics Certificate", "Microsoft Power BI Data Analyst (PL-300)", "Tableau Desktop Specialist"],
    mistake: "Listing tools without impact — pair each tool ('SQL', 'Power BI') with a business result it produced.",
  },
];

export const JOB_SLUGS = JOBS.map((j) => j.slug);
export const getJob = (slug: string) => JOBS.find((j) => j.slug === slug);
export const CATEGORIES = Array.from(new Set(JOBS.map((j) => j.category)));
