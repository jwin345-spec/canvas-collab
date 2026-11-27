export type Tool = 'select' | 'sticky' | 'rect' | 'ellipse' | 'connector';

export interface ToolDefinition {
  id: Tool;
  label: string;
  /** Single-key shortcut, also exposed through `aria-keyshortcuts`. */
  shortcut: string;
}

export const TOOLS: readonly ToolDefinition[] = [
  { id: 'select', label: 'Select', shortcut: 'V' },
  { id: 'sticky', label: 'Sticky note', shortcut: 'S' },
  { id: 'rect', label: 'Rectangle', shortcut: 'R' },
  { id: 'ellipse', label: 'Ellipse', shortcut: 'O' },
  { id: 'connector', label: 'Connector', shortcut: 'C' },
];

export function isCreationTool(tool: Tool): tool is 'sticky' | 'rect' | 'ellipse' {
  return tool === 'sticky' || tool === 'rect' || tool === 'ellipse';
}
