import { cn } from 'cn';

/**
 * Text an agent (or a BPMN label) provided, rendered as plain text: React
 * escapes it, nothing is parsed as HTML or Markdown, line breaks stay. Every
 * rationale, question, note and evidence entry goes through here (CONCEPT §6:
 * "rationales render as plain text under a strict CSP").
 */
export function PlainText({
  text,
  className,
  as: Tag = 'p',
}: {
  text: string;
  className?: string;
  as?: 'p' | 'span' | 'div';
}) {
  return (
    <Tag data-plain-text="" className={cn('break-words whitespace-pre-wrap', className)}>
      {text}
    </Tag>
  );
}
