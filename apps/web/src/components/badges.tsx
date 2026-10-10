import type { EndpointState, ModelStage, RelationStatus, RelationType, Tier } from '@proa/client';
import { cn } from 'cn';
import {
  BookmarkIcon,
  CircleArrowRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  InboxIcon,
  KeyRoundIcon,
  LanguagesIcon,
  LinkIcon,
  LoaderCircleIcon,
  MailIcon,
  PenLineIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  TriangleIcon,
  TypeIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import type { Engine } from '@/lib/engine';
import { ENGINE_LABELS } from '@/lib/engine';
import {
  ENDPOINT_STATES,
  RELATION_STATUSES,
  RELATION_TYPES,
  STAGES,
  TIERS,
  type Tone,
} from '@/lib/labels';

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-success-soft text-success',
  info: 'bg-info-soft text-info',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  neutral: 'border-border bg-card text-muted-foreground',
  primary: 'bg-primary text-primary-foreground',
};

/** Badge in a Miragon status colour, always with icon and text (colour is never the only signal). */
export function ToneBadge({
  tone,
  icon: Icon,
  children,
  title,
  className,
}: {
  tone: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <Badge variant="outline" title={title} className={cn(TONE_CLASSES[tone], className)}>
      {Icon ? <Icon data-icon="inline-start" aria-hidden /> : null}
      {children}
    </Badge>
  );
}

export const STAGE_ICONS: Record<ModelStage, LucideIcon> = {
  waiting_for_agent: ClockIcon,
  agent_working: LoaderCircleIcon,
  agent_failed: TriangleAlertIcon,
  waiting_for_review: InboxIcon,
  waiting_for_clarification: CircleHelpIcon,
  incorporated: CircleCheckIcon,
};

export function StageBadge({ stage }: { stage: ModelStage }) {
  const p = STAGES[stage];
  return (
    <ToneBadge tone={p.tone} icon={STAGE_ICONS[stage]} title={p.hint}>
      {p.label}
    </ToneBadge>
  );
}

const STATUS_ICONS: Record<RelationStatus, LucideIcon> = {
  accepted: CircleCheckIcon,
  proposed: CircleDashedIcon,
  held: BookmarkIcon,
  rejected: CircleXIcon,
  obsolete: CircleSlashIcon,
};

export function StatusBadge({ status }: { status: RelationStatus }) {
  const p = RELATION_STATUSES[status];
  return (
    <ToneBadge tone={p.tone} icon={STATUS_ICONS[status]} title={p.hint}>
      {p.label}
    </ToneBadge>
  );
}

const TIER_ICONS: Record<Tier, LucideIcon> = {
  rule: ShieldCheckIcon,
  key: KeyRoundIcon,
  lexical: TypeIcon,
  semantic: LanguagesIcon,
  manual: PenLineIcon,
};

export function TierBadge({ tier }: { tier: Tier }) {
  const p = TIERS[tier];
  return (
    <ToneBadge tone={p.tone} icon={TIER_ICONS[tier]} title={p.hint}>
      {p.label}
    </ToneBadge>
  );
}

export const TYPE_ICONS: Record<RelationType, LucideIcon> = {
  call: WorkflowIcon,
  message: MailIcon,
  signal: TriangleIcon,
  trigger: CircleArrowRightIcon,
  manual: LinkIcon,
};

export function TypeLabel({ type }: { type: RelationType }) {
  const Icon = TYPE_ICONS[type];
  const p = RELATION_TYPES[type];
  return (
    <span className="inline-flex items-center gap-1.5" title={p.hint}>
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      {p.label}
    </span>
  );
}

export function EndpointStateBadge({ state }: { state: EndpointState }) {
  if (state === 'ok') return null;
  const p = ENDPOINT_STATES[state];
  return (
    <ToneBadge tone={p.tone} icon={TriangleAlertIcon} title={p.hint}>
      {p.label}
    </ToneBadge>
  );
}

export function EngineBadge({ engine }: { engine: Engine | null | undefined }) {
  if (engine === undefined) return <span className="text-muted-foreground">…</span>;
  if (engine === null) return <span className="text-muted-foreground">unbekannt</span>;
  return (
    <Badge variant="outline" title={ENGINE_LABELS[engine]} className="font-mono">
      {engine.toUpperCase()}
    </Badge>
  );
}
