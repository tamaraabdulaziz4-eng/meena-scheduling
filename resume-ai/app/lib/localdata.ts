"use client";

/**
 * Device-local user data (v1 of the account system): scan history, saved
 * resumes, and a mini job-application tracker — all in localStorage.
 *
 * Deliberately local-first: it matches the privacy pledge ("your resume is
 * never stored on our servers") and needs no signup. The data model mirrors
 * the planned Upstash schema (u:<email>:scans / :resumes / :jobs) so a later
 * server sync is a transport swap, not a redesign.
 */

export interface ScanEntry {
  id: string;
  ts: number;
  score: number;
  mode: "general" | "target";
  jobTitle: string; // first line of the JD, or "General review"
  lang: "en" | "ar";
  result: unknown; // the full OptimizeResult, for one-click restore
}

export interface SavedResume {
  id: string;
  ts: number;
  title: string;
  source: "built" | "optimized";
  text: string;
}

export type JobStatus = "saved" | "applied" | "interview" | "offer" | "rejected";
export interface JobEntry {
  id: string;
  ts: number;
  company: string;
  title: string;
  url: string;
  status: JobStatus;
  note: string;
}

const uid = () => Math.random().toString(36).slice(2, 10);

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function write<T>(key: string, list: T[], cap: number) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, cap)));
  } catch {
    /* storage full — drop oldest and retry once */
    try {
      localStorage.setItem(key, JSON.stringify(list.slice(0, Math.max(1, Math.floor(cap / 2)))));
    } catch { /* give up silently */ }
  }
}

// ── Scan history (cap 10) ──
export function addScan(e: Omit<ScanEntry, "id" | "ts">) {
  const list = read<ScanEntry>("ra_scan_history");
  list.unshift({ ...e, id: uid(), ts: Date.now() });
  write("ra_scan_history", list, 10);
}
export const getScans = () => read<ScanEntry>("ra_scan_history");
export function removeScan(id: string) {
  write("ra_scan_history", getScans().filter((s) => s.id !== id), 10);
}

// ── Saved resumes (cap 10) ──
export function saveResume(e: Omit<SavedResume, "id" | "ts">) {
  const list = read<SavedResume>("ra_saved_resumes");
  // Replace an identical-text duplicate instead of stacking copies.
  const filtered = list.filter((r) => r.text !== e.text);
  filtered.unshift({ ...e, id: uid(), ts: Date.now() });
  write("ra_saved_resumes", filtered, 10);
}
export const getResumes = () => read<SavedResume>("ra_saved_resumes");
export function removeResume(id: string) {
  write("ra_saved_resumes", getResumes().filter((r) => r.id !== id), 10);
}

// ── Job tracker (cap 50) ──
export function addJob(e: Omit<JobEntry, "id" | "ts">) {
  const list = read<JobEntry>("ra_jobs");
  list.unshift({ ...e, id: uid(), ts: Date.now() });
  write("ra_jobs", list, 50);
}
export const getJobs = () => read<JobEntry>("ra_jobs");
export function updateJob(id: string, patch: Partial<JobEntry>) {
  write("ra_jobs", getJobs().map((j) => (j.id === id ? { ...j, ...patch } : j)), 50);
}
export function removeJob(id: string) {
  write("ra_jobs", getJobs().filter((j) => j.id !== id), 50);
}
