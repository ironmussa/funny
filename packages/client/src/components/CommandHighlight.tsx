/* ── Lightweight synchronous bash command highlighter ── */
const CMD_RE =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|--?\w[\w-]*|\$\w+|&&|\|\||[|;]|(?:^|\s)(bun|bunx|npm|npx|node|git|oxlint|oxfmt|tsc|echo|exit|cd|mkdir|rm|cp|mv|cat|grep|sed|awk|curl|wget|make|cargo|docker|pytest|jest|vitest|secretlint|eslint|prettier)(?=\s|$))/g;

export function CommandHighlight({ command }: { command: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of command.matchAll(CMD_RE)) {
    const m = match[0];
    const idx = match.index!;

    // Text before this match
    if (idx > lastIndex) {
      parts.push(
        <span key={`t${lastIndex}`} className="text-foreground/80">
          {command.slice(lastIndex, idx)}
        </span>,
      );
    }

    // Known command (capture group 2)
    if (match[2]) {
      // There may be whitespace before the command keyword
      const pre = m.slice(0, m.indexOf(match[2]));
      if (pre)
        parts.push(
          <span key={`p${idx}`} className="text-foreground/80">
            {pre}
          </span>,
        );
      parts.push(
        <span key={`c${idx}`} className="text-[#e5c07b]">
          {match[2]}
        </span>,
      );
    } else if (m.startsWith('"') || m.startsWith("'")) {
      // String
      parts.push(
        <span key={`s${idx}`} className="text-[#98c379]">
          {m}
        </span>,
      );
    } else if (m.startsWith('-')) {
      // Flag
      parts.push(
        <span key={`f${idx}`} className="text-[#61afef]">
          {m}
        </span>,
      );
    } else if (m.startsWith('$')) {
      // Variable
      parts.push(
        <span key={`v${idx}`} className="text-[#c678dd]">
          {m}
        </span>,
      );
    } else {
      // Operators (&&, ||, |, ;)
      parts.push(
        <span key={`o${idx}`} className="text-[#c678dd]">
          {m}
        </span>,
      );
    }

    lastIndex = idx + m.length;
  }

  // Remaining text
  if (lastIndex < command.length) {
    parts.push(
      <span key={`e${lastIndex}`} className="text-foreground/80">
        {command.slice(lastIndex)}
      </span>,
    );
  }

  return (
    <div className="mt-0.5 min-w-0 overflow-hidden truncate rounded px-1.5 py-0.5 font-mono text-[11px]">
      {parts.length > 0 ? parts : command}
    </div>
  );
}
