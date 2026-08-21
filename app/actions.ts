'use server';

/**
 * Every write the UI makes.
 *
 * These are thin on purpose: read the form, call one function in
 * `src/lib/review/decisions`, revalidate. The rules that matter — provenance
 * saying a human decided, a merge that is transactional and reversible, a
 * rejection that sticks — are enforced in the domain layer, where the scraper
 * and a future CLI get them too. A server action that reimplemented any of them
 * would be a second place for them to drift.
 */
import { revalidatePath } from 'next/cache';
import {
  EDITABLE_FIELDS,
  acceptSuggestion,
  editLeadField,
  mergePair,
  rejectPair,
  rejectSuggestion,
  setLeadStatus,
  undoMerge,
  type EditableField,
} from '@/lib/review';
import { LEAD_STATUSES, type LeadStatus } from '@/lib/db';
import { db } from './lib/db';

/**
 * Who is deciding.
 *
 * There is no login: this is a single-operator tool on the owner's laptop, and
 * inventing an auth system to populate an audit column would be worse than
 * naming the operator. `REVIEWER` overrides it when a second person starts
 * using it, and every decision is stamped `reviewer:<id>` either way.
 */
function reviewer(): string {
  return process.env.REVIEWER ?? 'owner';
}

function required(form: FormData, key: string): string {
  const value = form.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing form field: ${key}`);
  }
  return value;
}

function leadId(form: FormData): number {
  const parsed = Number.parseInt(required(form, 'leadId'), 10);
  if (!Number.isFinite(parsed)) throw new Error('invalid leadId');
  return parsed;
}

export async function editFieldAction(form: FormData): Promise<void> {
  const id = leadId(form);
  const field = required(form, 'field');
  if (!(EDITABLE_FIELDS as readonly string[]).includes(field)) {
    throw new Error(`field ${field} is not editable`);
  }
  editLeadField(db(), {
    leadId: id,
    field: field as EditableField,
    value: required(form, 'value'),
    reviewer: reviewer(),
  });
  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
}

export async function setStatusAction(form: FormData): Promise<void> {
  const id = leadId(form);
  const status = required(form, 'status');
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`unknown status: ${status}`);
  }
  const note = form.get('note');
  setLeadStatus(db(), {
    leadId: id,
    status: status as LeadStatus,
    note: typeof note === 'string' ? note : null,
    reviewer: reviewer(),
  });
  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
}

export async function mergePairAction(form: FormData): Promise<void> {
  const candidateId = Number.parseInt(required(form, 'candidateId'), 10);
  const survivingLeadId = Number.parseInt(required(form, 'survivingLeadId'), 10);
  mergePair(db(), { candidateId, survivingLeadId, reviewer: reviewer() });
  revalidatePath('/merges');
  revalidatePath('/leads');
  revalidatePath('/');
}

export async function rejectPairAction(form: FormData): Promise<void> {
  const candidateId = Number.parseInt(required(form, 'candidateId'), 10);
  rejectPair(db(), { candidateId, reviewer: reviewer() });
  revalidatePath('/merges');
  revalidatePath('/');
}

export async function undoMergeAction(form: FormData): Promise<void> {
  const mergeLogId = Number.parseInt(required(form, 'mergeLogId'), 10);
  const note = form.get('note');
  undoMerge(db(), mergeLogId, reviewer(), typeof note === 'string' && note ? note : undefined);
  revalidatePath('/merges');
  revalidatePath('/leads');
  revalidatePath('/');
}

export async function acceptSuggestionAction(form: FormData): Promise<void> {
  const suggestionId = Number.parseInt(required(form, 'suggestionId'), 10);
  acceptSuggestion(db(), { suggestionId, reviewer: reviewer() });
  revalidatePath('/suggestions');
  revalidatePath('/leads');
}

export async function rejectSuggestionAction(form: FormData): Promise<void> {
  const suggestionId = Number.parseInt(required(form, 'suggestionId'), 10);
  rejectSuggestion(db(), { suggestionId, reviewer: reviewer() });
  revalidatePath('/suggestions');
  revalidatePath('/leads');
}
