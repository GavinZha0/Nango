/**
 * WASM AST Static Syntax & Undefined Symbol Scanner.
 *
 * Uses web-tree-sitter (WASM) to analyze Python and JavaScript source code
 * prior to sandbox execution for syntax errors and undeclared/unimported symbols.
 *
 * See docs/architecture-improvements.md and docs/sandbox.md.
 */

import "server-only";

import path from "path";
import Parser from "web-tree-sitter";
import type { StaticScanViolation } from "./static-scan";

// QUIRK: web-tree-sitter WASM parsers are initialised lazily per process.
let isParserInitialized = false;
let pythonLanguage: Parser.Language | null = null;
let jsLanguage: Parser.Language | null = null;

/** Common Python builtins that do not require an import statement. */
const PYTHON_BUILTINS = new Set([
  "print",
  "len",
  "range",
  "int",
  "str",
  "float",
  "dict",
  "list",
  "set",
  "tuple",
  "open",
  "type",
  "sum",
  "max",
  "min",
  "abs",
  "zip",
  "enumerate",
  "map",
  "filter",
  "any",
  "all",
  "isinstance",
  "issubclass",
  "super",
  "hasattr",
  "getattr",
  "setattr",
  "dir",
  "input",
  "round",
  "format",
  "slice",
  "sorted",
  "next",
  "iter",
  "repr",
  "False",
  "True",
  "None",
  "self",
  "cls",
  "Exception",
  "ValueError",
  "TypeError",
  "KeyError",
  "IndexError",
  "RuntimeError",
  "StopIteration",
  "FileNotFoundError",
  "exit",
  "quit",
]);

/** Common JavaScript globals that do not require an explicit import. */
const JS_GLOBALS = new Set([
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Error",
  "Promise",
  "Set",
  "Map",
  "Symbol",
  "process",
  "globalThis",
  "undefined",
  "null",
  "NaN",
  "Infinity",
  "parseInt",
  "parseFloat",
  "encodeURIComponent",
  "decodeURIComponent",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "fetch",
  "URL",
  "URLSearchParams",
  "Buffer",
]);

async function initAstParsers(): Promise<void> {
  if (!isParserInitialized) {
    await Parser.init({
      locateFile(scriptName: string) {
        if (scriptName === "tree-sitter.wasm") {
          return path.resolve(
            process.cwd(),
            "node_modules/web-tree-sitter/tree-sitter.wasm"
          );
        }
        return scriptName;
      },
    });
    isParserInitialized = true;
  }
}

async function getLanguage(lang: "python" | "javascript"): Promise<Parser.Language> {
  await initAstParsers();

  if (lang === "python") {
    if (!pythonLanguage) {
      const wasmPath = path.resolve(
        process.cwd(),
        "node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm"
      );
      pythonLanguage = await Parser.Language.load(wasmPath);
    }
    return pythonLanguage;
  } else {
    if (!jsLanguage) {
      const wasmPath = path.resolve(
        process.cwd(),
        "node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm"
      );
      jsLanguage = await Parser.Language.load(wasmPath);
    }
    return jsLanguage;
  }
}

/**
 * Perform WASM AST syntax & undeclared identifier inspection on code text.
 *
 * CONTRACT: This function does NOT throw on invalid code syntax; it returns
 * structured violations instead.
 */
export async function scanCodeAst(
  codeText: string,
  language: "python" | "javascript"
): Promise<StaticScanViolation[]> {
  try {
    const lang = await getLanguage(language);
    const parser = new Parser();
    parser.setLanguage(lang);

    const tree = parser.parse(codeText);
    const violations: StaticScanViolation[] = [];

    // 1. Syntax Error Check
    if (tree.rootNode.hasError) {
      let errorText = "";
      function findError(node: Parser.SyntaxNode) {
        if (node.type === "ERROR" || node.isError) {
          errorText = node.text;
          return;
        }
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.hasError) {
            findError(child);
            if (errorText) return;
          }
        }
      }
      findError(tree.rootNode);

      violations.push({
        ruleId: "SYNTAX_ERROR",
        message: `Syntax error in ${language} code: ${errorText || "Invalid language syntax"}`,
        severity: "error",
      });
      return violations;
    }

    // 2. Symbol / Import Check
    if (language === "python") {
      const importedNames = new Set<string>();
      const declaredNames = new Set<string>(PYTHON_BUILTINS);
      const usedRootIdentifiers = new Set<string>();

      function walkPython(node: Parser.SyntaxNode) {
        if (node.type === "import_statement") {
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (!child) continue;
            if (child.type === "dotted_name") importedNames.add(child.text);
            if (child.type === "aliased_import") {
              const alias = child.childForFieldName("alias");
              if (alias) importedNames.add(alias.text);
              else {
                const name = child.childForFieldName("name");
                if (name) importedNames.add(name.text);
              }
            }
          }
        }
        if (node.type === "import_from_statement") {
          const moduleName = node.childForFieldName("module_name");
          if (moduleName) importedNames.add(moduleName.text);
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (!child) continue;
            if (child.type === "aliased_import") {
              const alias = child.childForFieldName("alias");
              if (alias) importedNames.add(alias.text);
            } else if (child.type === "identifier") {
              importedNames.add(child.text);
            }
          }
        }
        if (node.type === "assignment") {
          const left = node.childForFieldName("left");
          if (left) {
            if (left.type === "identifier") declaredNames.add(left.text);
            if (left.type === "pattern_list" || left.type === "tuple") {
              for (let i = 0; i < left.childCount; i++) {
                const child = left.child(i);
                if (child && child.type === "identifier") declaredNames.add(child.text);
              }
            }
          }
        }
        if (node.type === "for_statement") {
          const left = node.childForFieldName("left");
          if (left && left.type === "identifier") declaredNames.add(left.text);
        }
        if (node.type === "function_definition") {
          const name = node.childForFieldName("name");
          if (name && name.type === "identifier") declaredNames.add(name.text);
        }
        if (node.type === "attribute") {
          const obj = node.childForFieldName("object");
          if (obj && obj.type === "identifier") {
            usedRootIdentifiers.add(obj.text);
          }
        }

        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) walkPython(child);
        }
      }

      walkPython(tree.rootNode);

      for (const id of usedRootIdentifiers) {
        if (!importedNames.has(id) && !declaredNames.has(id)) {
          violations.push({
            ruleId: "UNDEFINED_NAME",
            message: `Undefined identifier '${id}': missing 'import ${id}' (e.g. 'import pandas as ${id}')`,
            severity: "error",
          });
        }
      }
    } else if (language === "javascript") {
      const importedNames = new Set<string>();
      const declaredNames = new Set<string>(JS_GLOBALS);
      const usedRootIdentifiers = new Set<string>();

      function walkJS(node: Parser.SyntaxNode) {
        if (node.type === "variable_declarator") {
          const name = node.childForFieldName("name");
          if (name && name.type === "identifier") declaredNames.add(name.text);
        }
        if (node.type === "function_declaration") {
          const name = node.childForFieldName("name");
          if (name && name.type === "identifier") declaredNames.add(name.text);
        }
        if (node.type === "import_specifier" || node.type === "import_clause") {
          if (node.text) importedNames.add(node.text);
        }
        if (node.type === "call_expression") {
          const fn = node.childForFieldName("function");
          if (fn && fn.type === "identifier" && fn.text === "require") {
            if (node.parent && node.parent.type === "variable_declarator") {
              const name = node.parent.childForFieldName("name");
              if (name && name.type === "identifier") importedNames.add(name.text);
            }
          }
        }
        if (node.type === "member_expression") {
          const obj = node.childForFieldName("object");
          if (obj && obj.type === "identifier") usedRootIdentifiers.add(obj.text);
        }

        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) walkJS(child);
        }
      }

      walkJS(tree.rootNode);

      for (const id of usedRootIdentifiers) {
        if (!importedNames.has(id) && !declaredNames.has(id)) {
          violations.push({
            ruleId: "UNDEFINED_NAME",
            message: `Undefined identifier '${id}': missing import or declaration`,
            severity: "error",
          });
        }
      }
    }

    return violations;
  } catch (err) {
    // QUIRK: Catch WASM init/load errors gracefully so static scan returns warning.
    return [
      {
        ruleId: "AST_PARSER_ERROR",
        message: `Failed to execute WASM AST scan: ${err instanceof Error ? err.message : String(err)}`,
        severity: "warning",
      },
    ];
  }
}
