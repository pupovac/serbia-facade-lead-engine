/**
 * The detail page's two write forms.
 *
 * Server components with plain `<form action={serverAction}>` — no client
 * component, no `useState`. A reviewer with JavaScript disabled can still merge,
 * reject and correct, which is the right default for a tool whose whole job is
 * recording decisions.
 */
import type { LeadStatus } from '@/lib/db';
import { STATUS_LABELS } from '../../lib/format';

const STATUS_CHOICES: ReadonlyArray<{ value: LeadStatus; label: string; hint: string }> = [
  { value: 'approved', label: 'Odobri', hint: 'vredi zvati — zabeleži poziv u belešci' },
  { value: 'reviewed', label: 'Pregledano', hint: 'pogledano, odluka kasnije' },
  { value: 'rejected', label: 'Odbij', hint: 'nije naš kupac' },
];

export function StatusForm({
  leadId,
  status,
  action,
}: {
  leadId: number;
  status: string;
  action: (form: FormData) => Promise<void>;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="leadId" value={leadId} />
      <div className="field" style={{ marginBottom: 8 }}>
        <label htmlFor={`note-${leadId}`}>Beleška (npr. „pozvan 21.08, traži uzorak”)</label>
        <textarea id={`note-${leadId}`} name="note" rows={2} placeholder="šta je dogovoreno" />
      </div>
      <div className="actions">
        {STATUS_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="submit"
            name="status"
            value={choice.value}
            title={choice.hint}
            className={
              choice.value === 'approved' ? 'primary' : choice.value === 'rejected' ? 'danger' : ''
            }
            disabled={status === choice.value}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        Trenutno: <strong>{STATUS_LABELS[status] ?? status}</strong>
      </p>
    </form>
  );
}

/** One small form per editable field, so a correction is one click and one save. */
export function EditableFields({
  leadId,
  action,
  current,
  classificationOptions,
}: {
  leadId: number;
  action: (form: FormData) => Promise<void>;
  current: Record<string, string | null | undefined>;
  classificationOptions: ReadonlyArray<[string, string]>;
}) {
  const fields: ReadonlyArray<{ field: string; label: string }> = [
    { field: 'name', label: 'Naziv' },
    { field: 'address', label: 'Adresa' },
    { field: 'city', label: 'Grad' },
    { field: 'postal_code', label: 'Poštanski broj' },
    { field: 'registration_number', label: 'Matični broj' },
    { field: 'tax_id', label: 'PIB' },
    { field: 'legal_form', label: 'Pravna forma' },
  ];

  return (
    <>
      {fields.map(({ field, label }) => (
        <form key={field} action={action} className="inline-form" style={{ marginBottom: 6 }}>
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="field" value={field} />
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor={`${field}-${leadId}`}>{label}</label>
            <input
              type="text"
              id={`${field}-${leadId}`}
              name="value"
              defaultValue={current[field] ?? ''}
              style={{ width: '100%' }}
            />
          </div>
          <button type="submit">Sačuvaj</button>
        </form>
      ))}

      <form action={action} className="inline-form">
        <input type="hidden" name="leadId" value={leadId} />
        <input type="hidden" name="field" value="classification" />
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor={`classification-${leadId}`}>Tip</label>
          <select
            id={`classification-${leadId}`}
            name="value"
            defaultValue={current.classification ?? 'UNKNOWN'}
          >
            {classificationOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit">Sačuvaj</button>
      </form>
    </>
  );
}
