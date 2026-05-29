/**
 * Best-effort signature / type-string extraction for exported declarations.
 *
 * This is purely SYNTACTIC: it slices the relevant header text straight from
 * source (using Babel's character offsets) and normalizes whitespace, rather
 * than type-checking. That keeps it dependency-free and fast, at the cost of
 * not resolving inferred types — a `const x = foo()` with no annotation yields
 * no type string (documented limitation), while an annotated declaration
 * reproduces exactly what the author wrote.
 *
 * Used by the api_surface tool to describe each public symbol's shape without
 * the caller reading the file. Lives in its own module (no existing core file is
 * modified); it only consumes the read-only declaration classifiers from
 * `traverse.ts`.
 */
import * as t from "@babel/types";
import { spanOf } from "./parser.js";
import { memberName, modifiersOf } from "./traverse.js";
import type { Span, SymbolKind } from "./types.js";

/** Hard cap on any single signature string so a pathological declaration cannot
 * blow up the response. Truncated strings get an ellipsis. */
const MAX_SIGNATURE_LEN = 400;

/** A member of a class or interface, described for the public surface. */
export interface MemberSignature {
  name: string;
  kind: SymbolKind;
  /** A best-effort one-line signature/type for the member. */
  signature: string;
  static?: boolean;
  optional?: boolean;
  span: Span;
}

/** Collapse all runs of whitespace (incl. newlines) to single spaces, trim, cap. */
function normalize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SIGNATURE_LEN ? `${flat.slice(0, MAX_SIGNATURE_LEN)}…` : flat;
}

/** Slice raw source between two character offsets, guarding against missing offsets. */
function slice(code: string, start: number | null | undefined, end: number | null | undefined): string {
  if (start === null || start === undefined || end === null || end === undefined || end <= start) {
    return "";
  }
  return code.slice(start, end);
}

/** Render a type-annotation node (`: T`) as its source text without the leading colon. */
function typeAnnotationText(code: string, node: t.Node | null | undefined): string {
  const ann = (node as { typeAnnotation?: t.Node } | null | undefined)?.typeAnnotation;
  // A TSTypeAnnotation wraps the actual type in `.typeAnnotation`; slice the
  // inner type so we don't include the colon/whitespace.
  if (t.isTSTypeAnnotation(ann)) {
    return normalize(slice(code, ann.typeAnnotation.start, ann.typeAnnotation.end));
  }
  return "";
}

/**
 * Build a function signature `name(params): ReturnType` from a function-like
 * declaration. Slices the text from just after the name to the start of the
 * body (or to the node end for an ambient/overload declaration with no body),
 * which captures the parameter list, return type, and any generics exactly as
 * written. The provided `name` is prepended so anonymous default exports still
 * read sensibly.
 */
function functionSignature(code: string, node: t.FunctionDeclaration | t.TSDeclareFunction, name: string): string {
  // Start slicing after the identifier when present, else after the `function`
  // keyword region (decl.start). Using id.end keeps generics + params + return.
  const sliceStart = node.id ? node.id.end : node.start;
  const sliceEnd = "body" in node && node.body ? (node.body as t.Node).start : node.end;
  const tail = normalize(slice(code, sliceStart, sliceEnd));
  // tail looks like "(a: number): string" or "<T>(x: T): T". Re-attach the name.
  const asyncPrefix = (node as { async?: boolean }).async ? "async " : "";
  return `${asyncPrefix}${name}${tail}`.trim();
}

/** Build a `const name: Type` style signature for a variable declarator. */
function variableSignature(
  code: string,
  declKind: "const" | "let" | "var",
  id: t.Identifier,
  init: t.Expression | null | undefined
): string {
  const typeText = typeAnnotationText(code, id);
  if (typeText) return `${declKind} ${id.name}: ${typeText}`;
  // No explicit annotation: give a best-effort value-shape hint for the common
  // literal/function cases, since we deliberately do not run type inference.
  const hint = valueShapeHint(init);
  return hint ? `${declKind} ${id.name}: ${hint}` : `${declKind} ${id.name}`;
}

/** A coarse, syntactic hint for an un-annotated initializer (not real inference). */
function valueShapeHint(init: t.Expression | null | undefined): string {
  if (!init) return "";
  if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
    const asyncPrefix = init.async ? "async " : "";
    return `${asyncPrefix}(…) => …`;
  }
  if (t.isStringLiteral(init) || t.isTemplateLiteral(init)) return "string";
  if (t.isNumericLiteral(init)) return "number";
  if (t.isBooleanLiteral(init)) return "boolean";
  if (t.isArrayExpression(init)) return "array";
  if (t.isObjectExpression(init)) return "object";
  if (t.isNewExpression(init) && t.isIdentifier(init.callee)) return init.callee.name;
  return "";
}

/** Header of a class declaration: `class Name extends X implements Y` (no body). */
function classHeader(code: string, node: t.ClassDeclaration, name: string): string {
  const bodyStart = node.body.start;
  // Slice from the class name to the opening brace to capture type params,
  // `extends`, and `implements` exactly as written.
  const sliceStart = node.id ? node.id.start : node.start;
  const header = normalize(slice(code, sliceStart, bodyStart));
  const abstract = node.abstract ? "abstract " : "";
  // header begins with the name (or type params); ensure the declared name is present.
  return `${abstract}class ${header}`.replace(/\s+/g, " ").trim();
}

/** Public, named instance/static members of a class (skips private/#-prefixed). */
function classMembers(code: string, node: t.ClassDeclaration): MemberSignature[] {
  const out: MemberSignature[] = [];
  for (const member of node.body.body) {
    if (t.isClassMethod(member) || t.isClassPrivateMethod(member)) {
      // Skip TS `private`/`protected` and `#private` members — not public API.
      if (t.isClassPrivateMethod(member)) continue;
      if (isNonPublic(member)) continue;
      const name = memberName(member);
      if (name === undefined) continue;
      const mods = modifiersOf(member);
      const sliceStart = member.key.end;
      const sliceEnd = member.body ? (member.body as t.Node).start : member.end;
      const tail = normalize(slice(code, sliceStart, sliceEnd));
      const kind = member.kind === "get" ? "getter" : member.kind === "set" ? "setter" : "method";
      out.push({
        name,
        kind,
        signature: `${name}${tail}`,
        ...(mods.static ? { static: true } : {}),
        ...(member.optional ? { optional: true } : {}),
        span: spanOf(member)
      });
    } else if (t.isClassProperty(member)) {
      if (isNonPublic(member)) continue;
      const name = memberName(member);
      if (name === undefined) continue;
      const mods = modifiersOf(member);
      const typeText = typeAnnotationText(code, member);
      out.push({
        name,
        kind: "property",
        signature: typeText ? `${name}: ${typeText}` : name,
        ...(mods.static ? { static: true } : {}),
        ...(member.optional ? { optional: true } : {}),
        span: spanOf(member)
      });
    }
  }
  return out;
}

/** True when a class member carries a `private`/`protected` TS accessibility modifier. */
function isNonPublic(member: t.ClassMethod | t.ClassProperty): boolean {
  const access = (member as { accessibility?: string }).accessibility;
  return access === "private" || access === "protected";
}

/** Members of a TS interface, rendered as one-line signatures. */
function interfaceMembers(code: string, node: t.TSInterfaceDeclaration): MemberSignature[] {
  const out: MemberSignature[] = [];
  for (const member of node.body.body) {
    if (t.isTSMethodSignature(member)) {
      const name = keyName(member.key);
      if (name === undefined) continue;
      const tail = normalize(slice(code, member.key.end, member.end)).replace(/;$/, "");
      out.push({
        name,
        kind: "method",
        signature: `${name}${tail}`,
        ...(member.optional ? { optional: true } : {}),
        span: spanOf(member)
      });
    } else if (t.isTSPropertySignature(member)) {
      const name = keyName(member.key);
      if (name === undefined) continue;
      const typeText = typeAnnotationText(code, member);
      out.push({
        name,
        kind: "property",
        signature: typeText ? `${name}: ${typeText}` : name,
        ...(member.optional ? { optional: true } : {}),
        span: spanOf(member)
      });
    }
  }
  return out;
}

function keyName(key: t.Node): string | undefined {
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  return undefined;
}

/** The right-hand side of a type alias: `= <type>`, rendered as text. */
function typeAliasSignature(code: string, node: t.TSTypeAliasDeclaration, name: string): string {
  const params = node.typeParameters ? normalize(slice(code, node.typeParameters.start, node.typeParameters.end)) : "";
  const rhs = normalize(slice(code, node.typeAnnotation.start, node.typeAnnotation.end));
  return `type ${name}${params} = ${rhs}`;
}

/** Enum members (names only — values omitted for brevity). */
function enumMembers(node: t.TSEnumDeclaration): MemberSignature[] {
  return node.members.map((m) => ({
    name: t.isIdentifier(m.id) ? m.id.name : t.isStringLiteral(m.id) ? m.id.value : "<member>",
    kind: "property" as const,
    signature: t.isIdentifier(m.id) ? m.id.name : t.isStringLiteral(m.id) ? m.id.value : "<member>",
    span: spanOf(m)
  }));
}

/** The structured signature description for one exported declaration. */
export interface DeclarationSignature {
  /** A one-line signature/type string (best-effort, syntactic). */
  signature: string;
  /** Members of a class/interface/enum, when applicable. */
  members?: MemberSignature[];
}

/**
 * Produce a best-effort signature for a declaration node of a known kind.
 *
 * `name` is the PUBLIC name to render (which may differ from the declaration's
 * own id for a renamed or default export). `code` is the raw source of the file
 * the node belongs to (needed to slice type annotations the AST does not
 * stringify). Returns the signature plus, for container kinds, their members.
 *
 * Returns `undefined` only when the node kind carries no meaningful signature.
 */
export function declarationSignature(
  node: t.Node,
  kind: SymbolKind,
  code: string,
  name: string
): DeclarationSignature | undefined {
  if (t.isFunctionDeclaration(node) || t.isTSDeclareFunction(node)) {
    return { signature: functionSignature(code, node, name) };
  }
  if (t.isClassDeclaration(node)) {
    const members = classMembers(code, node);
    return { signature: classHeader(code, node, name), ...(members.length ? { members } : {}) };
  }
  if (t.isTSInterfaceDeclaration(node)) {
    const ext = node.extends && node.extends.length
      ? ` extends ${node.extends.map((e) => normalize(slice(code, e.start, e.end))).join(", ")}`
      : "";
    const params = node.typeParameters ? normalize(slice(code, node.typeParameters.start, node.typeParameters.end)) : "";
    const members = interfaceMembers(code, node);
    return { signature: `interface ${name}${params}${ext}`, ...(members.length ? { members } : {}) };
  }
  if (t.isTSTypeAliasDeclaration(node)) {
    return { signature: typeAliasSignature(code, node, name) };
  }
  if (t.isTSEnumDeclaration(node)) {
    const members = enumMembers(node);
    const constMod = node.const ? "const " : "";
    return { signature: `${constMod}enum ${name}`, ...(members.length ? { members } : {}) };
  }
  return undefined;
}

/**
 * Produce a `const/let/var name: Type` signature for a single variable
 * declarator inside a VariableDeclaration. Separate from `declarationSignature`
 * because one statement can bind several declarators (`export const a = 1, b =
 * 2`), each a distinct public symbol.
 */
export function variableDeclaratorSignature(
  declKind: "const" | "let" | "var",
  declarator: t.VariableDeclarator,
  code: string
): string | undefined {
  if (!t.isIdentifier(declarator.id)) return undefined;
  return variableSignature(code, declKind, declarator.id, declarator.init);
}
