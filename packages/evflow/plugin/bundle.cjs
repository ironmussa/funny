var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/plugin/index.ts
var exports_plugin = {};
__export(exports_plugin, {
  init: () => init
});
module.exports = __toCommonJS(exports_plugin);

// src/plugin/ast-utils.ts
var EVFLOW_METHODS = ["command", "event", "readModel", "automation", "sequence", "slice"];
var METHOD_TO_KIND = {
  command: "command",
  event: "event",
  readModel: "readModel",
  automation: "automation"
};
function isEvflowMethodCall(ts, node, methodName) {
  if (!ts.isCallExpression(node))
    return false;
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr))
    return false;
  const name = expr.name.text;
  if (methodName)
    return name === methodName;
  return EVFLOW_METHODS.includes(name);
}
function getMethodName(ts, call) {
  const expr = call.expression;
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }
  return;
}
function getFirstStringArg(ts, call) {
  const arg = call.arguments[0];
  if (arg && ts.isStringLiteral(arg))
    return arg;
  return;
}
function getOptionsArg(ts, call) {
  const arg = call.arguments[1];
  if (arg && ts.isObjectLiteralExpression(arg))
    return arg;
  return;
}
function getProperty(ts, obj, propName) {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === propName) {
      return prop;
    }
  }
  return;
}
function getStringArrayElements(ts, node) {
  if (!ts.isArrayLiteralExpression(node))
    return [];
  return node.elements.filter((el) => ts.isStringLiteral(el));
}
function getStringProperty(ts, obj, propName) {
  const prop = getProperty(ts, obj, propName);
  if (prop && ts.isStringLiteral(prop.initializer)) {
    return prop.initializer;
  }
  return;
}
function getStringOrArrayProperty(ts, obj, propName) {
  const prop = getProperty(ts, obj, propName);
  if (!prop)
    return [];
  if (ts.isStringLiteral(prop.initializer)) {
    return [prop.initializer];
  }
  if (ts.isArrayLiteralExpression(prop.initializer)) {
    return getStringArrayElements(ts, prop.initializer);
  }
  return [];
}
function parseSequenceString(value, stringStart) {
  const steps = [];
  const parts = value.split("->");
  let offset = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) {
      const nameStart = value.indexOf(trimmed, offset);
      steps.push({
        name: trimmed,
        start: stringStart + 1 + nameStart,
        length: trimmed.length
      });
    }
    offset += part.length + 2;
  }
  return steps;
}

// src/plugin/registry.ts
function buildRegistry(ts, sourceFile) {
  const registry = new Map;
  function visit(node) {
    if (isEvflowMethodCall(ts, node)) {
      const call = node;
      const method = getMethodName(ts, call);
      if (!method)
        return;
      const kind = METHOD_TO_KIND[method];
      if (!kind) {
        ts.forEachChild(node, visit);
        return;
      }
      const nameNode = getFirstStringArg(ts, call);
      if (!nameNode) {
        ts.forEachChild(node, visit);
        return;
      }
      registry.set(nameNode.text, {
        name: nameNode.text,
        kind,
        nameStart: nameNode.getStart(sourceFile),
        nameEnd: nameNode.getEnd(),
        fileName: sourceFile.fileName
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return registry;
}
function buildProjectRegistry(ts, program) {
  const registry = new Map;
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile)
      continue;
    if (sourceFile.fileName.includes("node_modules"))
      continue;
    const fileRegistry = buildRegistry(ts, sourceFile);
    for (const [name, element] of fileRegistry) {
      registry.set(name, element);
    }
  }
  return registry;
}

// src/plugin/diagnostics.ts
var EVFLOW_ERROR_BASE = 20000;
function getEvflowDiagnostics(ts, sourceFile, registry) {
  const diagnostics = [];
  function visit(node) {
    if (!isEvflowMethodCall(ts, node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const call = node;
    const method = getMethodName(ts, call);
    if (!method) {
      ts.forEachChild(node, visit);
      return;
    }
    switch (method) {
      case "readModel":
        checkReadModel(ts, call, sourceFile, registry, diagnostics);
        break;
      case "automation":
        checkAutomation(ts, call, sourceFile, registry, diagnostics);
        break;
      case "sequence":
        checkSequence(ts, call, sourceFile, registry, diagnostics);
        break;
      case "slice":
        checkSlice(ts, call, sourceFile, registry, diagnostics);
        break;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return diagnostics;
}
function checkReadModel(ts, call, sourceFile, registry, diagnostics) {
  const opts = getOptionsArg(ts, call);
  if (!opts)
    return;
  const fromProp = getProperty(ts, opts, "from");
  if (!fromProp)
    return;
  const fromStrings = getStringArrayElements(ts, fromProp.initializer);
  for (const str of fromStrings) {
    const el = registry.get(str.text);
    if (!el) {
      diagnostics.push(makeDiag(ts, sourceFile, str, `Unknown event "${str.text}"`, ts.DiagnosticCategory.Error));
    } else if (el.kind !== "event") {
      diagnostics.push(makeDiag(ts, sourceFile, str, `"${str.text}" is a ${el.kind}, expected an event`, ts.DiagnosticCategory.Error));
    }
  }
}
function checkAutomation(ts, call, sourceFile, registry, diagnostics) {
  const opts = getOptionsArg(ts, call);
  if (!opts)
    return;
  const onStr = getStringProperty(ts, opts, "on");
  if (onStr) {
    const el = registry.get(onStr.text);
    if (!el) {
      diagnostics.push(makeDiag(ts, sourceFile, onStr, `Unknown event "${onStr.text}"`, ts.DiagnosticCategory.Error));
    } else if (el.kind !== "event") {
      diagnostics.push(makeDiag(ts, sourceFile, onStr, `"${onStr.text}" is a ${el.kind}, expected an event`, ts.DiagnosticCategory.Error));
    }
  }
  const triggersStrings = getStringOrArrayProperty(ts, opts, "triggers");
  for (const str of triggersStrings) {
    const el = registry.get(str.text);
    if (!el) {
      diagnostics.push(makeDiag(ts, sourceFile, str, `Unknown command "${str.text}"`, ts.DiagnosticCategory.Error));
    } else if (el.kind !== "command") {
      diagnostics.push(makeDiag(ts, sourceFile, str, `"${str.text}" is a ${el.kind}, expected a command`, ts.DiagnosticCategory.Warning));
    }
  }
}
function checkSequence(ts, call, sourceFile, registry, diagnostics) {
  const secondArg = call.arguments[1];
  if (!secondArg || !ts.isStringLiteral(secondArg))
    return;
  const steps = parseSequenceString(secondArg.text, secondArg.getStart(sourceFile));
  for (const step of steps) {
    if (!registry.has(step.name)) {
      diagnostics.push({
        file: sourceFile,
        start: step.start,
        length: step.length,
        messageText: `Unknown element "${step.name}" in sequence`,
        category: ts.DiagnosticCategory.Error,
        code: EVFLOW_ERROR_BASE + 4,
        source: "evflow"
      });
    }
  }
}
function checkSlice(ts, call, sourceFile, registry, diagnostics) {
  const opts = getOptionsArg(ts, call);
  if (!opts)
    return;
  const checks = [
    { prop: "commands", expectedKind: "command" },
    { prop: "events", expectedKind: "event" },
    { prop: "readModels", expectedKind: "readModel" },
    { prop: "automations", expectedKind: "automation" }
  ];
  for (const { prop, expectedKind } of checks) {
    const propNode = getProperty(ts, opts, prop);
    if (!propNode)
      continue;
    const strings = getStringArrayElements(ts, propNode.initializer);
    for (const str of strings) {
      const el = registry.get(str.text);
      if (!el) {
        diagnostics.push(makeDiag(ts, sourceFile, str, `Unknown element "${str.text}"`, ts.DiagnosticCategory.Error));
      } else if (expectedKind && el.kind !== expectedKind) {
        diagnostics.push(makeDiag(ts, sourceFile, str, `"${str.text}" is a ${el.kind}, expected a ${expectedKind}`, ts.DiagnosticCategory.Warning));
      }
    }
  }
}
function makeDiag(ts, sourceFile, node, message, category) {
  return {
    file: sourceFile,
    start: node.getStart(sourceFile),
    length: node.getWidth(sourceFile),
    messageText: message,
    category,
    code: EVFLOW_ERROR_BASE + (category === ts.DiagnosticCategory.Error ? 1 : 2),
    source: "evflow"
  };
}

// src/plugin/completions.ts
function getEvflowCompletions(ts, sourceFile, position, registry) {
  const token = findTokenAtPosition(ts, sourceFile, position);
  if (!token || !ts.isStringLiteral(token))
    return;
  const context = getCompletionContext(ts, token);
  if (!context)
    return;
  const entries = [];
  for (const el of registry.values()) {
    if (context.filter && !context.filter.includes(el.kind))
      continue;
    entries.push({
      name: el.name,
      kind: kindToScriptElementKind(ts, el.kind),
      kindModifiers: "",
      sortText: `0_${el.name}`,
      labelDetails: { description: el.kind }
    });
  }
  return entries.length > 0 ? entries : undefined;
}
function getCompletionContext(ts, stringNode) {
  let current = stringNode;
  if (current.parent && ts.isArrayLiteralExpression(current.parent)) {
    current = current.parent;
  }
  if (current.parent && ts.isPropertyAssignment(current.parent)) {
    const propAssignment = current.parent;
    const propName = ts.isIdentifier(propAssignment.name) ? propAssignment.name.text : "";
    const objLit = propAssignment.parent;
    if (!objLit || !ts.isObjectLiteralExpression(objLit))
      return;
    const callExpr = objLit.parent;
    if (!callExpr || !ts.isCallExpression(callExpr))
      return;
    if (!isEvflowMethodCall(ts, callExpr))
      return;
    const method = getMethodName(ts, callExpr);
    switch (method) {
      case "readModel":
        if (propName === "from")
          return { filter: ["event"] };
        break;
      case "automation":
        if (propName === "on")
          return { filter: ["event"] };
        if (propName === "triggers")
          return { filter: ["command"] };
        break;
      case "slice":
        if (propName === "commands")
          return { filter: ["command"] };
        if (propName === "events")
          return { filter: ["event"] };
        if (propName === "readModels")
          return { filter: ["readModel"] };
        if (propName === "automations")
          return { filter: ["automation"] };
        break;
    }
    return;
  }
  if (current.parent && ts.isCallExpression(current.parent)) {
    const call = current.parent;
    if (!isEvflowMethodCall(ts, call))
      return;
    const method = getMethodName(ts, call);
    if (method === "sequence" && call.arguments[1] === stringNode) {
      return { filter: undefined };
    }
  }
  return;
}
function findTokenAtPosition(ts, sourceFile, position) {
  function find(node) {
    if (position >= node.getStart(sourceFile) && position <= node.getEnd()) {
      const child = ts.forEachChild(node, find);
      return child || node;
    }
    return;
  }
  return find(sourceFile);
}
function kindToScriptElementKind(ts, kind) {
  switch (kind) {
    case "command":
      return ts.ScriptElementKind.functionElement;
    case "event":
      return ts.ScriptElementKind.classElement;
    case "readModel":
      return ts.ScriptElementKind.interfaceElement;
    case "automation":
      return ts.ScriptElementKind.moduleElement;
    default:
      return ts.ScriptElementKind.unknown;
  }
}

// src/plugin/index.ts
function init(modules) {
  const tsModule = modules.typescript;
  function create(info) {
    const oldLS = info.languageService;
    const proxy = Object.create(null);
    for (const k in oldLS) {
      const x = oldLS[k];
      proxy[k] = typeof x === "function" ? (...args) => x.apply(oldLS, args) : x;
    }
    info.project.projectService.logger.info("[evflow] Plugin loaded");
    proxy.getSemanticDiagnostics = (fileName) => {
      const original = oldLS.getSemanticDiagnostics(fileName);
      const program = oldLS.getProgram();
      if (!program)
        return original;
      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile || sourceFile.isDeclarationFile)
        return original;
      if (fileName.includes("node_modules"))
        return original;
      try {
        const registry = buildProjectRegistry(tsModule, program);
        if (registry.size === 0)
          return original;
        const evflowDiags = getEvflowDiagnostics(tsModule, sourceFile, registry);
        return [...original, ...evflowDiags];
      } catch (e) {
        info.project.projectService.logger.info(`[evflow] Error in getSemanticDiagnostics: ${e}`);
        return original;
      }
    };
    proxy.getCompletionsAtPosition = (fileName, position, options, formattingSettings) => {
      const original = oldLS.getCompletionsAtPosition(fileName, position, options, formattingSettings);
      const program = oldLS.getProgram();
      if (!program)
        return original;
      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile || sourceFile.isDeclarationFile)
        return original;
      try {
        const registry = buildProjectRegistry(tsModule, program);
        if (registry.size === 0)
          return original;
        const evflowEntries = getEvflowCompletions(tsModule, sourceFile, position, registry);
        if (!evflowEntries)
          return original;
        if (original) {
          return {
            ...original,
            entries: [...evflowEntries, ...original.entries]
          };
        }
        return {
          isGlobalCompletion: false,
          isMemberCompletion: false,
          isNewIdentifierLocation: false,
          entries: evflowEntries
        };
      } catch (e) {
        info.project.projectService.logger.info(`[evflow] Error in getCompletionsAtPosition: ${e}`);
        return original;
      }
    };
    return proxy;
  }
  return { create };
}
