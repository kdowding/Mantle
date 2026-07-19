// Type surface for the vendored smd.js streaming markdown parser
// (ui/src/lib/smd.js, MIT — thetarnav). Only the slice the reveal clock
// uses is declared; the .js is the implementation (not type-checked).

export interface RendererData {
  /** DOM nodes the renderer has created for the current parse. */
  nodes: Node[];
  /** Index into `nodes` of the node just added. */
  index: number;
}

export interface Renderer {
  add_token: (data: RendererData, type: number) => void;
  end_token: (data: RendererData) => void;
  add_text: (data: RendererData, text: string) => void;
  set_attr: (data: RendererData, type: number, value: string) => void;
}

/** Opaque parser handle — created by parser(), fed to parser_write/parser_end. */
export type Parser = object;

export function default_renderer(root: HTMLElement): Renderer;
export function parser(renderer: Renderer): Parser;
export function parser_write(parser: Parser, chunk: string): void;
export function parser_end(parser: Parser): void;
