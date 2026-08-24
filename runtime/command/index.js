// ../host-workspace/deepseek-harness/packages/host/remote-command/src/index.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ../host-workspace/deepseek-harness/vendor/cosmokit/src/misc.ts
function isNullable(value) {
  return value === null || value === void 0;
}
function isPlainObject(data) {
  return data && typeof data === "object" && !Array.isArray(data);
}
function filterKeys(object, filter) {
  return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
function mapValues(object, transform) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
function pick(source, keys, forced) {
  if (!keys) return { ...source };
  const result = {};
  for (const key of keys) {
    if (forced || source[key] !== void 0) result[key] = source[key];
  }
  return result;
}

// ../host-workspace/deepseek-harness/vendor/cosmokit/src/types.ts
function is(type, value) {
  if (arguments.length === 1) return (value2) => is(type, value2);
  return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
  return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
  return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
var Binary;
((Binary2) => {
  Binary2.is = isArrayBufferLike;
  Binary2.isSource = isArrayBufferSource;
  function fromSource(source) {
    if (ArrayBuffer.isView(source)) {
      return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    } else {
      return source;
    }
  }
  Binary2.fromSource = fromSource;
  function toBase64(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") {
      return Buffer.from(source).toString("base64");
    }
    let binary = "";
    const bytes = new Uint8Array(source);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  Binary2.toBase64 = toBase64;
  function fromBase64(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
    return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
  }
  Binary2.fromBase64 = fromBase64;
  function toHex(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
    return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  Binary2.toHex = toHex;
  function fromHex(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
    const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
    const buffer = [];
    for (let i = 0; i < hex.length; i += 2) {
      buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
    }
    return Uint8Array.from(buffer).buffer;
  }
  Binary2.fromHex = fromHex;
})(Binary || (Binary = {}));
var base64ToArrayBuffer = Binary.fromBase64;
var arrayBufferToBase64 = Binary.toBase64;
var hexToArrayBuffer = Binary.fromHex;
var arrayBufferToHex = Binary.toHex;
function clone(source, refs = /* @__PURE__ */ new Map()) {
  if (!source || typeof source !== "object") return source;
  if (is("Date", source)) return new Date(source.valueOf());
  if (is("RegExp", source)) return new RegExp(source.source, source.flags);
  if (isArrayBufferLike(source)) return source.slice(0);
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const cached = refs.get(source);
  if (cached) return cached;
  if (Array.isArray(source)) {
    const result2 = [];
    refs.set(source, result2);
    source.forEach((value, index) => {
      result2[index] = Reflect.apply(clone, null, [value, refs]);
    });
    return result2;
  }
  const result = Object.create(Object.getPrototypeOf(source));
  refs.set(source, result);
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
    if ("value" in descriptor) {
      descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
    }
    Reflect.defineProperty(result, key, descriptor);
  }
  return result;
}
function deepEqual(a, b, strict) {
  if (a === b) return true;
  if (!strict && isNullable(a) && isNullable(b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (!a || !b) return false;
  function check(test, then) {
    return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
  }
  return check(Array.isArray, (a2, b2) => a2.length === b2.length && a2.every((item, index) => deepEqual(item, b2[index]))) ?? check(is("Date"), (a2, b2) => a2.valueOf() === b2.valueOf()) ?? check(is("RegExp"), (a2, b2) => a2.source === b2.source && a2.flags === b2.flags) ?? check(isArrayBufferLike, (a2, b2) => {
    if (a2.byteLength !== b2.byteLength) return false;
    const viewA = new Uint8Array(a2);
    const viewB = new Uint8Array(b2);
    for (let i = 0; i < viewA.length; i++) {
      if (viewA[i] !== viewB[i]) return false;
    }
    return true;
  }) ?? Object.keys({ ...a, ...b }).every((key) => deepEqual(a[key], b[key], strict));
}

// ../host-workspace/deepseek-harness/vendor/cosmokit/src/time.ts
var Time;
((Time2) => {
  Time2.millisecond = 1;
  Time2.second = 1e3;
  Time2.minute = Time2.second * 60;
  Time2.hour = Time2.minute * 60;
  Time2.day = Time2.hour * 24;
  Time2.week = Time2.day * 7;
  let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
  function setTimezoneOffset(offset) {
    timezoneOffset = offset;
  }
  Time2.setTimezoneOffset = setTimezoneOffset;
  function getTimezoneOffset() {
    return timezoneOffset;
  }
  Time2.getTimezoneOffset = getTimezoneOffset;
  function getDateNumber(date2 = /* @__PURE__ */ new Date(), offset) {
    if (typeof date2 === "number") date2 = new Date(date2);
    if (offset === void 0) offset = timezoneOffset;
    return Math.floor((date2.valueOf() / Time2.minute - offset) / 1440);
  }
  Time2.getDateNumber = getDateNumber;
  function fromDateNumber(value, offset) {
    const date2 = new Date(value * Time2.day);
    if (offset === void 0) offset = timezoneOffset;
    return new Date(+date2 + offset * Time2.minute);
  }
  Time2.fromDateNumber = fromDateNumber;
  const numeric = /\d+(?:\.\d+)?/.source;
  const timeRegExp = new RegExp(`^${[
    "w(?:eek(?:s)?)?",
    "d(?:ay(?:s)?)?",
    "h(?:our(?:s)?)?",
    "m(?:in(?:ute)?(?:s)?)?",
    "s(?:ec(?:ond)?(?:s)?)?"
  ].map((unit) => `(${numeric}${unit})?`).join("")}$`);
  function parseTime(source) {
    const capture = timeRegExp.exec(source);
    if (!capture) return 0;
    return (parseFloat(capture[1]) * Time2.week || 0) + (parseFloat(capture[2]) * Time2.day || 0) + (parseFloat(capture[3]) * Time2.hour || 0) + (parseFloat(capture[4]) * Time2.minute || 0) + (parseFloat(capture[5]) * Time2.second || 0);
  }
  Time2.parseTime = parseTime;
  function parseDate(date2) {
    const parsed = parseTime(date2);
    if (parsed) {
      date2 = Date.now() + parsed;
    } else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) {
      date2 = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date2}`;
    } else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) {
      date2 = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date2}`;
    }
    return date2 ? new Date(date2) : /* @__PURE__ */ new Date();
  }
  Time2.parseDate = parseDate;
  function format(ms) {
    const abs = Math.abs(ms);
    if (abs >= Time2.day - Time2.hour / 2) {
      return Math.round(ms / Time2.day) + "d";
    } else if (abs >= Time2.hour - Time2.minute / 2) {
      return Math.round(ms / Time2.hour) + "h";
    } else if (abs >= Time2.minute - Time2.second / 2) {
      return Math.round(ms / Time2.minute) + "m";
    } else if (abs >= Time2.second) {
      return Math.round(ms / Time2.second) + "s";
    }
    return ms + "ms";
  }
  Time2.format = format;
  function toDigits(source, length = 2) {
    return source.toString().padStart(length, "0");
  }
  Time2.toDigits = toDigits;
  function template(template2, time = /* @__PURE__ */ new Date()) {
    return template2.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
  }
  Time2.template = template;
})(Time || (Time = {}));

// ../host-workspace/deepseek-harness/vendor/schemastery/src/index.ts
var kSchema = /* @__PURE__ */ Symbol.for("schemastery");
var kValidationError = /* @__PURE__ */ Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
  constructor(message, options) {
    let prefix = "$";
    for (const segment of options.path || []) {
      if (typeof segment === "string") {
        prefix += "." + segment;
      } else if (typeof segment === "number") {
        prefix += "[" + segment + "]";
      } else if (typeof segment === "symbol") {
        prefix += `[Symbol(${segment.toString()})]`;
      }
    }
    if (prefix.startsWith(".")) prefix = prefix.slice(1);
    super((prefix === "$" ? "" : `${prefix} `) + message);
    this.options = options;
  }
  options;
  name = "ValidationError";
  static is(error) {
    return !!error?.[kValidationError];
  }
};
Object.defineProperty(ValidationError.prototype, kValidationError, {
  value: true
});
var Schema = function(options) {
  const schema = function(data, options2 = {}) {
    return Schema.resolve(data, schema, options2)[0];
  };
  if (options.refs) {
    const refs = mapValues(options.refs, (options2) => new Schema(options2));
    const getRef = (uid) => refs[uid];
    for (const key in refs) {
      const options2 = refs[key];
      options2.sKey = getRef(options2.sKey);
      options2.inner = getRef(options2.inner);
      options2.list = options2.list && options2.list.map(getRef);
      options2.dict = options2.dict && mapValues(options2.dict, getRef);
    }
    return refs[options.uid];
  }
  Object.assign(schema, options);
  if (typeof schema.callback === "string") {
    try {
      schema.callback = new Function("return " + schema.callback)();
    } catch {
    }
  }
  Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
  Object.setPrototypeOf(schema, Schema.prototype);
  schema.meta ||= {};
  schema.toString = schema.toString.bind(schema);
  return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", {
  get() {
    return {
      version: 1,
      vendor: "schemastery",
      validate: (value) => {
        try {
          return { value: Schema.resolve(value, this, {})[0] };
        } catch (error) {
          if (ValidationError.is(error)) {
            return { issues: [{ message: error.message, path: error.options.path }] };
          }
          throw error;
        }
      }
    };
  }
});
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
  if (globalThis.__schemastery_refs__) {
    globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
    return this.uid;
  }
  globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
  globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
  const result = { uid: this.uid, refs: globalThis.__schemastery_refs__ };
  globalThis.__schemastery_refs__ = void 0;
  return result;
};
Schema.prototype.set = function set(key, value) {
  this.dict[key] = value;
  return this;
};
Schema.prototype.push = function push(value) {
  this.list.push(value);
  return this;
};
function mergeDesc(original, messages) {
  const result = typeof original === "string" ? { "": original } : { ...original };
  for (const locale in messages) {
    const value = messages[locale];
    if (value?.$description || value?.$desc) {
      result[locale] = value.$description || value.$desc;
    } else if (typeof value === "string") {
      result[locale] = value;
    }
  }
  return result;
}
function getInner(value) {
  return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
  return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
  const schema = Schema(this);
  const desc = mergeDesc(schema.meta.description, messages);
  if (Object.keys(desc).length) schema.meta.description = desc;
  if (schema.dict) {
    schema.dict = mapValues(schema.dict, (inner, key) => {
      return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
    });
  }
  if (schema.list) {
    schema.list = schema.list.map((inner, index) => {
      return inner.i18n(mapValues(messages, (data = {}) => {
        if (Array.isArray(getInner(data))) return getInner(data)[index];
        if (Array.isArray(data)) return data[index];
        return extractKeys(data);
      }));
    });
  }
  if (schema.inner) {
    schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
      if (getInner(data)) return getInner(data);
      return extractKeys(data);
    }));
  }
  if (schema.sKey) {
    schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
  }
  return schema;
};
Schema.prototype.extra = function extra(key, value) {
  const schema = Schema(this);
  schema.meta = { ...schema.meta, [key]: value };
  return schema;
};
for (const key of ["required", "disabled", "collapse", "hidden", "loose"]) {
  Object.assign(Schema.prototype, {
    [key](value = true) {
      const schema = Schema(this);
      schema.meta = { ...schema.meta, [key]: value };
      return schema;
    }
  });
}
Schema.prototype.deprecated = function deprecated() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({ text: "deprecated", type: "danger" });
  return schema;
};
Schema.prototype.experimental = function experimental() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({ text: "experimental", type: "warning" });
  return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
  const schema = Schema(this);
  const pattern2 = pick(regexp, ["source", "flags"]);
  schema.meta = { ...schema.meta, pattern: pattern2 };
  return schema;
};
Schema.prototype.simplify = function simplify(value) {
  if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
  if (isNullable(value)) return value;
  if (this.type === "object" || this.type === "dict") {
    const result = {};
    for (const key in value) {
      const schema = this.type === "object" ? this.dict[key] : this.inner;
      const item = schema?.simplify(value[key]);
      if (this.type === "dict" || !isNullable(item)) result[key] = item;
    }
    if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
    return result;
  } else if (this.type === "array" || this.type === "tuple") {
    const result = [];
    value.forEach((value2, index) => {
      const schema = this.type === "array" ? this.inner : this.list[index];
      const item = schema ? schema.simplify(value2) : value2;
      result.push(item);
    });
    return result;
  } else if (this.type === "intersect") {
    const result = {};
    for (const item of this.list) {
      Object.assign(result, item.simplify(value));
    }
    return result;
  } else if (this.type === "union") {
    for (const schema of this.list) {
      try {
        Schema.resolve(value, schema, {});
        return schema.simplify(value);
      } catch {
      }
    }
  }
  return value;
};
Schema.prototype.toString = function toString(inline) {
  return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra2) {
  const schema = Schema(this);
  schema.meta = { ...schema.meta, role, extra: extra2 };
  return schema;
};
for (const key of ["default", "link", "comment", "description", "max", "min", "step"]) {
  Object.assign(Schema.prototype, {
    [key](value) {
      const schema = Schema(this);
      schema.meta = { ...schema.meta, [key]: value };
      return schema;
    }
  });
}
var resolvers = {};
Schema.extend = function extend(type, resolve2) {
  resolvers[type] = resolve2;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
  if (!schema) return [data];
  if (options.ignore?.(data, schema)) return [data];
  if (isNullable(data) && schema.type !== "lazy") {
    if (schema.meta.required) throw new ValidationError(`missing required value`, options);
    let current = schema;
    let fallback = schema.meta.default;
    while (current?.type === "intersect" && isNullable(fallback)) {
      current = current.list[0];
      fallback = current?.meta.default;
    }
    if (isNullable(fallback)) return [data];
    data = clone(fallback);
  }
  const callback = resolvers[schema.type];
  if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
  try {
    return callback(data, schema, options, strict);
  } catch (error) {
    if (!schema.meta.loose) throw error;
    return [schema.meta.default];
  }
};
Schema.from = function from(source) {
  if (isNullable(source)) {
    return Schema.any();
  } else if (["string", "number", "boolean"].includes(typeof source)) {
    return Schema.const(source).required();
  } else if (source[kSchema]) {
    return source;
  } else if (typeof source === "function") {
    switch (source) {
      case String:
        return Schema.string().required();
      case Number:
        return Schema.number().required();
      case Boolean:
        return Schema.boolean().required();
      case Function:
        return Schema.function().required();
      default:
        return Schema.is(source).required();
    }
  } else {
    throw new TypeError(`cannot infer schema from ${source}`);
  }
};
Schema.lazy = function lazy(builder) {
  const toJSON2 = () => {
    if (!schema.inner[kSchema]) {
      schema.inner = schema.builder();
      schema.inner.meta = { ...schema.meta, ...schema.inner.meta };
    }
    return schema.inner.toJSON();
  };
  const schema = new Schema({ type: "lazy", builder, inner: { toJSON: toJSON2 } });
  return schema;
};
Schema.natural = function natural() {
  return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
  return Schema.number().step(0.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
  return Schema.union([
    Schema.is(Date),
    Schema.transform(Schema.string().role("datetime"), (value, options) => {
      const date2 = new Date(value);
      if (isNaN(+date2)) throw new ValidationError(`invalid date "${value}"`, options);
      return date2;
    }, true)
  ]);
};
Schema.regExp = function regExp(flag = "") {
  return Schema.union([
    Schema.is(RegExp),
    Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
      try {
        return new RegExp(value, flag);
      } catch (e) {
        throw new ValidationError(e.message, options);
      }
    }, true)
  ]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
  return Schema.union([
    Schema.is(ArrayBuffer),
    Schema.is(SharedArrayBuffer),
    Schema.transform(Schema.any(), (value, options) => {
      if (Binary.isSource(value)) return Binary.fromSource(value);
      throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
    }, true),
    ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
      try {
        return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
      } catch (e) {
        throw new ValidationError(e.message, options);
      }
    }, true)] : []
  ]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
  if (!schema.inner[kSchema]) {
    schema.inner = schema.builder();
    schema.inner.meta = { ...schema.meta, ...schema.inner.meta };
  }
  return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
  return [data];
});
Schema.extend("never", (data, _, options) => {
  throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
  if (deepEqual(data, value)) return [value];
  throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
  const { max = Infinity, min = -Infinity } = meta;
  if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
  if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
  if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
  if (meta.pattern) {
    const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
    if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
  }
  checkWithinRange(data.length, meta, "string length", options);
  return [data];
});
function decimalShift(data, digits) {
  const str = data.toString();
  if (str.includes("e")) return data * Math.pow(10, digits);
  const index = str.indexOf(".");
  if (index === -1) return data * Math.pow(10, digits);
  const frac = str.slice(index + 1);
  const integer = str.slice(0, index);
  if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
  return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
  step = Math.abs(step);
  if (!/^\d+\.\d+$/.test(step.toString())) {
    return (data - min) % step === 0;
  }
  const index = step.toString().indexOf(".");
  const digits = step.toString().slice(index + 1).length;
  return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
  if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
  checkWithinRange(data, meta, "number", options);
  const { step } = meta;
  if (step && !isMultipleOf(data, meta.min ?? 0, step)) {
    throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
  }
  return [data];
});
Schema.extend("boolean", (data, _, options) => {
  if (typeof data === "boolean") return [data];
  throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
  let value = 0, keys = [];
  if (typeof data === "number") {
    value = data;
    for (const key in bits) {
      if (data & bits[key]) {
        keys.push(key);
      }
    }
  } else if (Array.isArray(data)) {
    keys = data;
    for (const key of keys) {
      if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
      if (key in bits) value |= bits[key];
    }
  } else {
    throw new ValidationError(`expected number or array but got ${data}`, options);
  }
  if (value === meta.default) return [value];
  return [value, keys];
});
Schema.extend("function", (data, _, options) => {
  if (typeof data === "function") return [data];
  throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
  if (typeof constructor === "function") {
    if (data instanceof constructor) return [data];
    throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
  } else {
    if (isNullable(data)) {
      throw new ValidationError(`expected ${constructor} but got ${data}`, options);
    }
    let prototype = Object.getPrototypeOf(data);
    while (prototype) {
      if (prototype.constructor?.name === constructor) return [data];
      prototype = Object.getPrototypeOf(prototype);
    }
    throw new ValidationError(`expected ${constructor} but got ${data}`, options);
  }
});
function property(data, key, schema, options) {
  try {
    const [value, adapted] = Schema.resolve(data[key], schema, {
      ...options,
      path: [...options.path || [], key]
    });
    if (adapted !== void 0) data[key] = adapted;
    return value;
  } catch (e) {
    if (!options?.autofix) throw e;
    delete data[key];
    return schema.meta.default;
  }
}
Schema.extend("array", (data, { inner, meta }, options) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
  return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in data) {
    let rKey;
    try {
      rKey = Schema.resolve(key, sKey, options)[0];
    } catch (error) {
      if (strict) continue;
      throw error;
    }
    result[rKey] = property(data, key, inner, options);
    data[rKey] = data[key];
    if (key !== rKey) delete data[key];
  }
  return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  const result = list.map((inner, index) => property(data, index, inner, options));
  if (strict) return [result];
  result.push(...data.slice(list.length));
  return [result];
});
function merge(result, data) {
  for (const key in data) {
    if (key in result) continue;
    result[key] = data[key];
  }
}
Schema.extend("object", (data, { dict }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in dict) {
    const value = property(data, key, dict[key], options);
    if (!isNullable(value) || key in data) {
      result[key] = value;
    }
  }
  if (!strict) merge(result, data);
  return [result];
});
Schema.extend("union", (data, { list, toString: toString2 }, options, strict) => {
  const messages = [];
  for (const inner of list) {
    try {
      return Schema.resolve(data, inner, options, strict);
    } catch (error) {
      messages.push(error);
    }
  }
  throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString: toString2 }, options, strict) => {
  if (!list.length) return [data];
  let result;
  for (const inner of list) {
    const value = Schema.resolve(data, inner, options, true)[0];
    if (isNullable(value)) continue;
    if (isNullable(result)) {
      result = value;
    } else if (typeof result !== typeof value) {
      throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
    } else if (typeof value === "object") {
      merge(result ??= {}, value);
    } else if (result !== value) {
      throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
    }
  }
  if (!strict && isPlainObject(data)) merge(result, data);
  return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
  const [result, adapted = data] = Schema.resolve(data, inner, options, true);
  if (preserve) {
    return [callback(result)];
  } else {
    return [callback(result), callback(adapted)];
  }
});
var formatters = {};
function defineMethod(name2, keys, format) {
  formatters[name2] = format;
  Object.assign(Schema, {
    [name2](...args) {
      const schema = new Schema({ type: name2 });
      keys.forEach((key, index) => {
        switch (key) {
          case "sKey":
            schema.sKey = args[index] ?? Schema.string();
            break;
          case "inner":
            schema.inner = Schema.from(args[index]);
            break;
          case "list":
            schema.list = args[index].map(Schema.from);
            break;
          case "dict":
            schema.dict = mapValues(args[index], Schema.from);
            break;
          case "bits": {
            schema.bits = {};
            for (const key2 in args[index]) {
              if (typeof args[index][key2] !== "number") continue;
              schema.bits[key2] = args[index][key2];
            }
            break;
          }
          case "callback": {
            const callback = schema.callback = args[index];
            callback["toJSON"] ||= () => callback.toString();
            break;
          }
          case "constructor": {
            const constructor = schema.constructor = args[index];
            if (typeof constructor === "function") {
              ;
              constructor["toJSON"] ||= () => constructor["name"];
            }
            break;
          }
          default:
            schema[key] = args[index];
        }
      });
      if (name2 === "object" || name2 === "dict") {
        schema.meta.default = {};
      } else if (name2 === "array" || name2 === "tuple") {
        schema.meta.default = [];
      } else if (name2 === "bitset") {
        schema.meta.default = 0;
      }
      return schema;
    }
  });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
  if (typeof constructor === "function") {
    return constructor.name;
  } else {
    return constructor;
  }
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
  if (Object.keys(dict).length === 0) return "{}";
  return `{ ${Object.entries(dict).map(([key, inner]) => {
    return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
  }).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
  const result = list.map(({ toString: format }) => format()).join(" | ");
  return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
  return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", ["inner", "callback", "preserve"], ({ inner }, isInner) => inner.toString(isInner));
var src_default = Schema;

// ../host-workspace/deepseek-harness/packages/host/remote-command/src/index.ts
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy/api";

// ../host-workspace/deepseek-harness/packages/host/remote-command/src/executor.ts
import {
  fingerprintRemoteApprovalDecision,
  fingerprintRemoteCreateSession,
  fingerprintRemoteForkSession,
  fingerprintRemoteRevokeApprovalRule,
  fingerprintRemoteSelectAgentPreset,
  fingerprintRemoteSelectModel,
  fingerprintRemoteSendInput,
  fingerprintRemoteSetSessionBudget,
  fingerprintRemoteStop
} from "@w2112515/dsh-remote-host/control";
function terminalFromRow(row, replayed) {
  return row.phase === "committed" ? Object.freeze({ outcome: "committed", commandId: row.commandId, replayed }) : Object.freeze({
    outcome: "rejected",
    commandId: row.commandId,
    replayed,
    errorCode: row.rejection.code
  });
}
function stopTerminalFromRow(row, expectedActivityRevision, replayed) {
  return row.phase === "committed" ? Object.freeze({
    outcome: "stopped",
    commandId: row.commandId,
    expectedActivityRevision,
    replayed
  }) : Object.freeze({
    outcome: "rejected",
    commandId: row.commandId,
    expectedActivityRevision,
    replayed,
    errorCode: row.rejection.code
  });
}
var RemoteCommandExecutor = class {
  /**
   * @param prompts - Host-only two-phase ApiProxy admission face.
   * @param stops - Host-only exact-turn cancellation and physical terminal inspection.
   * @param control - durable idempotency and control-fence owner.
   * @param logger - contained callback and post-commit wake diagnostics.
   * @param stopSettlementTimeoutMs - caller-visible wait before returning honest UNKNOWN while ownership continues.
   * @param approvals - Host-only approval decision face.
   * @param sessionAdmin - Host-only Session create/preset-select face (S-mode-select).
   * @param policy - lazy Host session-policy face (S-policy); absent keeps policy commands refused.
   */
  constructor(prompts, stops, control, logger, stopSettlementTimeoutMs = 3e4, approvals, sessionAdmin, policy) {
    this.prompts = prompts;
    this.stops = stops;
    this.control = control;
    this.logger = logger;
    this.stopSettlementTimeoutMs = stopSettlementTimeoutMs;
    this.approvals = approvals;
    this.sessionAdmin = sessionAdmin;
    this.policy = policy;
  }
  prompts;
  stops;
  control;
  logger;
  stopSettlementTimeoutMs;
  approvals;
  sessionAdmin;
  policy;
  inFlight = /* @__PURE__ */ new Map();
  stopInFlight = /* @__PURE__ */ new Map();
  approvalInFlight = /* @__PURE__ */ new Map();
  adminInFlight = /* @__PURE__ */ new Map();
  admissionOpen = true;
  async sendInput(authority, command, onReceived) {
    if (!this.admissionOpen) throw new Error("remote command executor is disposing");
    const requestFingerprint = fingerprintRemoteSendInput({
      sessionId: command.sessionId,
      text: command.text,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch,
      ...command.attachmentIds === void 0 ? {} : { attachmentIds: command.attachmentIds }
    });
    const binding = Object.freeze({
      commandId: command.commandId,
      operation: "send_input",
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch
    });
    const reservation = await this.control.reserveCommand(binding);
    if (reservation.kind === "conflict") {
      return Object.freeze({
        outcome: "rejected",
        commandId: command.commandId,
        replayed: true,
        errorCode: "command-id-reused"
      });
    }
    if (reservation.kind === "replay") {
      if (reservation.row.phase === "rejected") return terminalFromRow(reservation.row, true);
      return this.replayCommitted(reservation.row);
    }
    if (reservation.row.phase !== "reserved") {
      return this.unknown(command, "journal-operation-conflict", true);
    }
    const replayed = reservation.kind === "pending";
    this.notifyReceived(onReceived, {
      outcome: "received",
      commandId: command.commandId,
      replayed
    });
    const existing = this.inFlight.get(command.commandId);
    if (existing !== void 0) return this.withReplay(await existing, true);
    const operation = this.execute(authority, command, reservation.row, replayed);
    this.inFlight.set(command.commandId, operation);
    try {
      return this.withReplay(await operation, replayed);
    } finally {
      if (this.inFlight.get(command.commandId) === operation) this.inFlight.delete(command.commandId);
    }
  }
  async stop(authority, command, onRequested) {
    if (!this.admissionOpen) throw new Error("remote command executor is disposing");
    const requestFingerprint = fingerprintRemoteStop({
      sessionId: command.sessionId,
      targetTurn: command.expectedActivityRevision,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch
    });
    const binding = Object.freeze({
      commandId: command.commandId,
      operation: "stop",
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch,
      targetTurn: command.expectedActivityRevision
    });
    const reservation = await this.control.reserveCommand(binding);
    if (reservation.kind === "conflict") {
      return this.stopRejected(command, "command-id-reused", true);
    }
    if (reservation.kind === "replay") {
      if (reservation.row.phase === "rejected") {
        return stopTerminalFromRow(reservation.row, command.expectedActivityRevision, true);
      }
      return this.replayStopped(command, reservation.row);
    }
    if (reservation.row.phase === "requested") {
      this.notifyStopRequested(onRequested, command, true);
    }
    const existing = this.stopInFlight.get(command.commandId);
    if (existing !== void 0) return this.awaitStop(existing, command, true);
    const operation = this.executeStop(authority, command, reservation.row, onRequested);
    this.stopInFlight.set(command.commandId, operation);
    void operation.finally(() => {
      if (this.stopInFlight.get(command.commandId) === operation) this.stopInFlight.delete(command.commandId);
    }).catch(() => {
    });
    return this.awaitStop(operation, command, reservation.kind === "pending");
  }
  async decideApproval(authority, command, onReceived) {
    if (!this.admissionOpen) throw new Error("remote command executor is disposing");
    const requestFingerprint = fingerprintRemoteApprovalDecision({
      sessionId: command.sessionId,
      approvalId: command.approvalId,
      approvalRevision: command.approvalRevision,
      outcome: command.outcome,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      ...command.grantSameKind === true ? { grantSameKind: true } : {}
    });
    const binding = Object.freeze({
      commandId: command.commandId,
      operation: "decide_approval",
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      approvalId: command.approvalId,
      approvalRevision: command.approvalRevision,
      approvalOutcome: command.outcome
    });
    const reservation = await this.control.reserveCommand(binding);
    if (reservation.kind === "conflict") {
      return Object.freeze({
        outcome: "rejected",
        commandId: command.commandId,
        replayed: true,
        errorCode: "command-id-reused"
      });
    }
    if (reservation.kind === "replay") {
      if (reservation.row.phase === "rejected") return terminalFromRow(reservation.row, true);
      return this.replayApproval(command, reservation.row);
    }
    if (reservation.row.phase !== "reserved") {
      return this.unknown(command, "journal-operation-conflict", true);
    }
    const replayed = reservation.kind === "pending";
    this.notifyReceived(onReceived, { outcome: "received", commandId: command.commandId, replayed });
    const existing = this.approvalInFlight.get(command.commandId);
    if (existing !== void 0) return this.withReplay(await existing, true);
    const operation = this.executeApproval(authority, command, reservation.row, replayed);
    this.approvalInFlight.set(command.commandId, operation);
    try {
      return this.withReplay(await operation, replayed);
    } finally {
      if (this.approvalInFlight.get(command.commandId) === operation) {
        this.approvalInFlight.delete(command.commandId);
      }
    }
  }
  async createSession(authority, command, onReceived) {
    if (!this.admissionOpen) throw new Error("remote command executor is disposing");
    const requestFingerprint = fingerprintRemoteCreateSession({
      sessionId: command.sessionId,
      agentPreset: command.agentPreset,
      workspaceId: command.workspaceId,
      newWorkspaceName: command.newWorkspaceName,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch
    });
    const binding = Object.freeze({
      commandId: command.commandId,
      operation: "create_session",
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      ...command.agentPreset === void 0 ? {} : { agentPreset: command.agentPreset }
    });
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      if (this.sessionAdmin === void 0) return { ok: false, errorCode: "session-admin-unavailable" };
      try {
        return await this.sessionAdmin.createSession({
          sessionId: command.sessionId,
          ...command.agentPreset === void 0 ? {} : { agentPreset: command.agentPreset },
          ...command.workspaceId === void 0 ? {} : { workspaceId: command.workspaceId },
          ...command.newWorkspaceName === void 0 ? {} : { newWorkspaceName: command.newWorkspaceName }
        });
      } catch {
        return { ok: false, errorCode: "session-admin-unavailable" };
      }
    }, async () => {
      if (this.sessionAdmin === void 0) return false;
      try {
        const again = await this.sessionAdmin.createSession({
          sessionId: command.sessionId,
          ...command.agentPreset === void 0 ? {} : { agentPreset: command.agentPreset },
          ...command.workspaceId === void 0 ? {} : { workspaceId: command.workspaceId },
          ...command.newWorkspaceName === void 0 ? {} : { newWorkspaceName: command.newWorkspaceName }
        });
        return again.ok;
      } catch {
        return false;
      }
    }, (result) => ({
      created: true,
      ...result.agentPreset === void 0 ? {} : { agentPreset: result.agentPreset }
    }));
  }
  async selectAgentPreset(authority, command, onReceived) {
    if (!this.admissionOpen) throw new Error("remote command executor is disposing");
    const requestFingerprint = fingerprintRemoteSelectAgentPreset({
      sessionId: command.sessionId,
      agentPreset: command.agentPreset,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch
    });
    const binding = Object.freeze({
      commandId: command.commandId,
      operation: "select_agent_preset",
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      agentPreset: command.agentPreset
    });
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      if (this.sessionAdmin === void 0) return { ok: false, errorCode: "session-admin-unavailable" };
      try {
        return await this.sessionAdmin.selectAgentPreset({
          sessionId: command.sessionId,
          agentPreset: command.agentPreset
        });
      } catch {
        return { ok: false, errorCode: "session-admin-unavailable" };
      }
    }, async () => {
      if (this.sessionAdmin === void 0) return false;
      try {
        const again = await this.sessionAdmin.selectAgentPreset({
          sessionId: command.sessionId,
          agentPreset: command.agentPreset
        });
        return again.ok;
      } catch {
        return false;
      }
    }, () => ({ selectedPreset: command.agentPreset }));
  }
  async selectModel(authority, command, onReceived) {
    if (!this.admissionOpen) throw new Error("remote command executor is disposing");
    const modelSelection = Object.freeze({
      provider: command.provider,
      model: command.model,
      ...command.reasoningEffort === void 0 ? {} : { reasoningEffort: command.reasoningEffort }
    });
    const requestFingerprint = fingerprintRemoteSelectModel({
      sessionId: command.sessionId,
      provider: command.provider,
      model: command.model,
      reasoningEffort: command.reasoningEffort,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch
    });
    const binding = Object.freeze({
      commandId: command.commandId,
      operation: "select_model",
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      controlEpoch: command.control.epoch,
      modelSelection
    });
    const reservation = await this.control.reserveCommand(binding);
    if (reservation.kind === "conflict") {
      return Object.freeze({
        outcome: "rejected",
        commandId: command.commandId,
        replayed: true,
        errorCode: "command-id-reused"
      });
    }
    if (reservation.kind === "replay") {
      if (reservation.row.phase === "rejected") return terminalFromRow(reservation.row, true);
      return await this.reproveSelectModel(command) ? terminalFromRow(reservation.row, true) : this.unknown(command, "committed-fact-unavailable", true);
    }
    if (reservation.row.phase !== "reserved") {
      return this.unknown(command, "journal-operation-conflict", true);
    }
    const replayed = reservation.kind === "pending";
    this.notifyReceived(onReceived, { outcome: "received", commandId: command.commandId, replayed });
    const existing = this.adminInFlight.get(command.commandId);
    if (existing !== void 0) return this.withReplay(await existing, true);
    const operation = this.executeSelectModel(authority, command, reservation.row);
    this.adminInFlight.set(command.commandId, operation);
    try {
      return this.withReplay(await operation, replayed);
    } finally {
      if (this.adminInFlight.get(command.commandId) === operation) {
        this.adminInFlight.delete(command.commandId);
      }
    }
  }
  async forkSession(authority, command, onReceived) {
    if (!this.admissionOpen) throw new Error("remote command executor is disposing");
    const requestFingerprint = fingerprintRemoteForkSession({
      sessionId: command.sessionId,
      childSessionId: command.childSessionId,
      atSeq: command.atSeq,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch
    });
    const binding = Object.freeze({
      commandId: command.commandId,
      operation: "fork_session",
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      childSessionId: command.childSessionId,
      ...command.atSeq === void 0 ? {} : { forkAtSeq: command.atSeq }
    });
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      if (this.sessionAdmin === void 0) return { ok: false, errorCode: "session-admin-unavailable" };
      try {
        return await this.sessionAdmin.forkSession({
          sessionId: command.sessionId,
          childSessionId: command.childSessionId,
          ...command.atSeq === void 0 ? {} : { atSeq: command.atSeq }
        });
      } catch {
        return { ok: false, errorCode: "session-admin-unavailable" };
      }
    }, async () => {
      if (this.sessionAdmin === void 0) return false;
      try {
        const again = await this.sessionAdmin.forkSession({
          sessionId: command.sessionId,
          childSessionId: command.childSessionId,
          ...command.atSeq === void 0 ? {} : { atSeq: command.atSeq }
        });
        return again.ok;
      } catch {
        return false;
      }
    }, () => ({ forked: true, childSessionId: command.childSessionId }));
  }
  async revokeApprovalRule(authority, command, onReceived) {
    if (!this.admissionOpen) throw new Error("remote command executor is disposing");
    const requestFingerprint = fingerprintRemoteRevokeApprovalRule({
      sessionId: command.sessionId,
      ruleId: command.ruleId,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch
    });
    const binding = Object.freeze({
      commandId: command.commandId,
      operation: "revoke_approval_rule",
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      ruleId: command.ruleId
    });
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      const policy = this.policy?.();
      if (policy === void 0) return { ok: false, errorCode: "approval-policy-unavailable" };
      try {
        return await policy.revokeRule({ sessionId: command.sessionId, ruleId: command.ruleId });
      } catch {
        return { ok: false, errorCode: "approval-policy-unavailable" };
      }
    }, () => {
      const policy = this.policy?.();
      if (policy === void 0) return Promise.resolve(false);
      try {
        return Promise.resolve(!policy.isRuleActive({ sessionId: command.sessionId, ruleId: command.ruleId }));
      } catch {
        return Promise.resolve(false);
      }
    }, () => ({ revokedRuleId: command.ruleId }));
  }
  async setSessionBudget(authority, command, onReceived) {
    if (!this.admissionOpen) throw new Error("remote command executor is disposing");
    const requestFingerprint = fingerprintRemoteSetSessionBudget({
      sessionId: command.sessionId,
      maxTotalTokens: command.maxTotalTokens,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch
    });
    const binding = Object.freeze({
      commandId: command.commandId,
      operation: "set_session_budget",
      sessionId: command.sessionId,
      requestFingerprint,
      deviceId: authority.deviceId,
      authorityEpoch: authority.authorityEpoch,
      maxTotalTokens: command.maxTotalTokens
    });
    return this.runAdminCommand(authority, command, binding, onReceived, async () => {
      const policy = this.policy?.();
      if (policy === void 0) return { ok: false, errorCode: "approval-policy-unavailable" };
      try {
        return await policy.setBudget({ sessionId: command.sessionId, maxTotalTokens: command.maxTotalTokens });
      } catch {
        return { ok: false, errorCode: "approval-policy-unavailable" };
      }
    }, async () => {
      const policy = this.policy?.();
      if (policy === void 0) return false;
      try {
        if (policy.currentBudget(command.sessionId) === command.maxTotalTokens) return true;
        const again = await policy.setBudget({
          sessionId: command.sessionId,
          maxTotalTokens: command.maxTotalTokens
        });
        return again.ok;
      } catch {
        return false;
      }
    }, () => ({ budgetSet: true, maxTotalTokens: command.maxTotalTokens }));
  }
  async reproveSelectModel(command) {
    if (this.sessionAdmin === void 0) return false;
    try {
      const again = await this.sessionAdmin.selectModel({
        sessionId: command.sessionId,
        provider: command.provider,
        model: command.model,
        ...command.reasoningEffort === void 0 ? {} : { reasoningEffort: command.reasoningEffort }
      });
      return again.ok;
    } catch {
      return false;
    }
  }
  async executeSelectModel(authority, command, row) {
    const proofFailure = command.control.sessionId !== command.sessionId || command.control.holderDeviceId !== authority.deviceId;
    if (proofFailure) return this.reject(row, "invalid-control-proof");
    const preflight = await this.authorizedAdmission(command, authority, () => void 0);
    if (preflight.kind === "threw") return this.reject(row, "authorization-denied");
    if (preflight.kind === "refused") return this.reject(row, preflight.errorCode);
    const sessionAdmin = this.sessionAdmin;
    if (sessionAdmin === void 0) return this.reject(row, "session-admin-unavailable");
    let result;
    try {
      result = await sessionAdmin.selectModel({
        sessionId: command.sessionId,
        provider: command.provider,
        model: command.model,
        ...command.reasoningEffort === void 0 ? {} : { reasoningEffort: command.reasoningEffort }
      });
    } catch {
      return this.unknown(command, "session-admin-unavailable");
    }
    if (!result.ok) return this.reject(row, result.errorCode);
    try {
      await this.control.commitCommand(command.commandId, row.requestFingerprint, {
        selectedModel: {
          provider: command.provider,
          model: command.model,
          ...command.reasoningEffort === void 0 ? {} : { reasoningEffort: command.reasoningEffort }
        }
      });
    } catch (error) {
      this.logger.warn(`remote-command: durable model selection committed but journal repair is pending: ${String(error)}`);
    }
    return Object.freeze({ outcome: "committed", commandId: command.commandId, replayed: false });
  }
  /**
   * Shared reserve/dedup/execute/replay pipeline for the lease-free session
   * admin commands (S-mode-select, S-session-admin fork). Each owner call is
   * set-valued and idempotent, so a reserved-but-unproven row converges by
   * re-execution and a committed row is re-proven by the same call.
   */
  async runAdminCommand(authority, command, binding, onReceived, effect, reprove, commit) {
    const reservation = await this.control.reserveCommand(binding);
    if (reservation.kind === "conflict") {
      return Object.freeze({
        outcome: "rejected",
        commandId: command.commandId,
        replayed: true,
        errorCode: "command-id-reused"
      });
    }
    if (reservation.kind === "replay") {
      if (reservation.row.phase === "rejected") return terminalFromRow(reservation.row, true);
      return await reprove() ? terminalFromRow(reservation.row, true) : this.unknown(command, "committed-fact-unavailable", true);
    }
    const reservedRow = reservation.row;
    if (reservedRow.phase !== "reserved") {
      return this.unknown(command, "journal-operation-conflict", true);
    }
    const replayed = reservation.kind === "pending";
    this.notifyReceived(onReceived, { outcome: "received", commandId: command.commandId, replayed });
    const existing = this.adminInFlight.get(command.commandId);
    if (existing !== void 0) return this.withReplay(await existing, true);
    const operation = (async () => {
      try {
        authority.authorize();
      } catch {
        return this.reject(reservedRow, "authorization-denied");
      }
      const result = await effect();
      if (!result.ok) return this.reject(reservedRow, result.errorCode);
      try {
        await this.control.commitCommand(command.commandId, reservedRow.requestFingerprint, commit(result));
      } catch (error) {
        this.logger.warn(`remote-command: durable session admin effect committed but journal repair is pending: ${String(error)}`);
      }
      return Object.freeze({ outcome: "committed", commandId: command.commandId, replayed: false });
    })();
    this.adminInFlight.set(command.commandId, operation);
    try {
      return this.withReplay(await operation, replayed);
    } finally {
      if (this.adminInFlight.get(command.commandId) === operation) {
        this.adminInFlight.delete(command.commandId);
      }
    }
  }
  /** Stop new commands and await every accepted owner operation. */
  async close() {
    this.admissionOpen = false;
    await Promise.allSettled([
      ...this.inFlight.values(),
      ...this.stopInFlight.values(),
      ...this.approvalInFlight.values(),
      ...this.adminInFlight.values()
    ]);
  }
  async execute(authority, command, row, reconcile) {
    const correlation = row.correlation;
    if (reconcile) {
      let inspection;
      try {
        inspection = await this.prompts.inspect(command.sessionId, correlation);
      } catch (error) {
        this.logger.warn(`remote-command: inspect threw: ${String(error)}`);
        console.error(`remote-command: inspect threw: ${String(error)}`);
        inspection = { kind: "absent" };
      }
      if (inspection.kind === "conflict") return this.unknown(command, "correlation-conflict", true);
      if (inspection.kind === "pending") return this.unknown(command, "durability-pending", true);
      if (inspection.kind === "committed") {
        return this.repairCommit(row, inspection);
      }
    }
    const proofFailure = command.control.sessionId !== command.sessionId || command.control.holderDeviceId !== authority.deviceId;
    if (proofFailure) return this.reject(row, "invalid-control-proof");
    const preflight = await this.authorizedAdmission(command, authority, () => void 0);
    if (preflight.kind === "threw") return this.reject(row, "authorization-denied");
    if (preflight.kind === "refused") return this.reject(row, preflight.errorCode);
    let budgetGate;
    try {
      budgetGate = this.policy?.()?.evaluateBudget(command.sessionId);
    } catch {
      budgetGate = void 0;
    }
    if (budgetGate?.exhausted === true) return this.reject(row, "budget-exhausted");
    const prepared = await this.prompts.prepareText({
      sessionId: command.sessionId,
      text: command.text,
      correlation,
      ...command.attachmentIds === void 0 ? {} : { images: command.attachmentIds.map((id) => id) }
    });
    if (!prepared.ok) return this.reject(row, prepared.error.code);
    const admitted = await this.authorizedAdmission(command, authority, () => prepared.prepared.admit());
    if (admitted.kind === "threw") return this.unknown(command, "admission-outcome-unknown");
    if (admitted.kind === "refused") return this.reject(row, admitted.errorCode);
    if (!admitted.value.ok) return this.reject(row, admitted.value.error.code);
    const receipt = admitted.value.receipt;
    if (receipt.correlation !== correlation) return this.unknown(command, "correlation-conflict");
    let durable;
    try {
      durable = await receipt.flush();
    } catch (error) {
      this.logger.warn(`remote-command: flush threw: ${String(error)}`);
      console.error(`remote-command: flush threw: ${String(error)}`);
      return this.unknown(command, "durability-unavailable");
    }
    if (!durable) return this.unknown(command, "durability-unavailable");
    const commit = {
      sessionEventSeq: receipt.sessionEventSeq,
      messageId: receipt.messageId
    };
    try {
      await this.control.commitCommand(command.commandId, row.requestFingerprint, commit);
    } catch (error) {
      this.logger.warn(`remote-command: durable Session input committed but journal repair is pending: ${String(error)}`);
    }
    try {
      receipt.wake();
    } catch (error) {
      this.logger.warn(`remote-command: durable Session input could not wake its Agent: ${String(error)}`);
    }
    return Object.freeze({ outcome: "committed", commandId: command.commandId, replayed: false });
  }
  async replayCommitted(row) {
    if (!("sessionEventSeq" in row.commit)) {
      return this.unknown({ commandId: row.commandId }, "committed-fact-unavailable", true);
    }
    try {
      const inspected = await this.prompts.inspect(
        row.sessionId,
        row.correlation
      );
      if (inspected.kind !== "committed" || inspected.messageId !== row.commit.messageId || inspected.sessionEventSeq !== row.commit.sessionEventSeq) {
        return this.unknown({ commandId: row.commandId }, "committed-fact-unavailable", true);
      }
      return terminalFromRow(row, true);
    } catch {
      return this.unknown({ commandId: row.commandId }, "reconciliation-unavailable", true);
    }
  }
  async repairCommit(row, inspection) {
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        sessionEventSeq: inspection.sessionEventSeq,
        messageId: inspection.messageId
      });
      if (inspection.pending) {
        try {
          await this.prompts.wakeCorrelated(
            row.sessionId,
            row.correlation
          );
        } catch (error) {
          this.logger.warn(`remote-command: repaired durable input could not wake its Agent: ${String(error)}`);
        }
      }
      return Object.freeze({ outcome: "committed", commandId: row.commandId, replayed: true });
    } catch {
      return this.unknown({ commandId: row.commandId }, "journal-unavailable", true);
    }
  }
  async executeApproval(authority, command, row, reconcile) {
    if (reconcile) {
      const inspection = await this.inspectApproval(command);
      if (inspection.kind === "conflict") return this.unknown(command, "approval-settlement-conflict", true);
      if (inspection.kind === "decided") {
        if (inspection.outcome !== command.outcome) {
          return this.reject(row, "approval-already-settled");
        }
        return this.repairApprovalCommit(command, row, inspection);
      }
    }
    try {
      authority.authorize();
    } catch {
      return this.reject(row, "authorization-denied");
    }
    if (this.approvals === void 0) return this.reject(row, "approval-owner-unavailable");
    const prepared = this.approvals.prepareDecision({
      sessionId: command.sessionId,
      approvalId: command.approvalId,
      revision: command.approvalRevision,
      outcome: command.outcome
    });
    if (!prepared.ok) return this.reject(row, prepared.error.code);
    if (command.grantSameKind === true) {
      if (command.outcome !== "allowed-once") {
        return this.reject(row, "approval-outcome-not-allowed");
      }
      const policy = this.policy?.();
      if (policy === void 0) return this.reject(row, "approval-policy-unavailable");
      const pending = this.approvals.list(command.sessionId).find((interaction) => String(interaction.approvalId) === command.approvalId);
      if (pending === void 0) return this.reject(row, "approval-not-pending");
      let granted;
      try {
        granted = await policy.grantForApproval({
          sessionId: command.sessionId,
          toolName: pending.toolName,
          ...pending.reason === void 0 ? {} : { reason: pending.reason }
        });
      } catch {
        return this.unknown(command, "approval-policy-unavailable");
      }
      if (!granted.ok) return this.reject(row, granted.errorCode);
    }
    let admitted;
    try {
      authority.authorize();
      admitted = prepared.prepared.admit();
    } catch {
      return this.reject(row, "authorization-denied");
    }
    if (!admitted.ok) return this.reject(row, admitted.error.code);
    let settled;
    try {
      settled = await admitted.receipt.settle();
    } catch {
      return this.unknown(command, "approval-settlement-unavailable");
    }
    if (!settled.durable || settled.inspection.kind !== "decided" || settled.inspection.outcome !== command.outcome) {
      return this.unknown(
        command,
        settled.inspection.kind === "conflict" ? "approval-settlement-conflict" : "approval-settlement-unavailable"
      );
    }
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        approvalId: command.approvalId,
        outcome: command.outcome,
        decidedEventSeq: settled.inspection.eventSeq
      });
    } catch (error) {
      this.logger.warn(`remote-command: durable approval decision committed but journal repair is pending: ${String(error)}`);
    }
    return Object.freeze({ outcome: "committed", commandId: command.commandId, replayed: false });
  }
  async replayApproval(command, row) {
    if (!("decidedEventSeq" in row.commit) || row.commit.approvalId !== command.approvalId || row.commit.outcome !== command.outcome) {
      return this.unknown(command, "committed-fact-unavailable", true);
    }
    const inspection = await this.inspectApproval(command);
    if (inspection.kind !== "decided" || inspection.eventSeq !== row.commit.decidedEventSeq || inspection.outcome !== command.outcome) {
      return this.unknown(command, "committed-fact-unavailable", true);
    }
    return terminalFromRow(row, true);
  }
  async repairApprovalCommit(command, row, inspection) {
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        approvalId: command.approvalId,
        outcome: command.outcome,
        decidedEventSeq: inspection.eventSeq
      });
      return Object.freeze({ outcome: "committed", commandId: command.commandId, replayed: true });
    } catch {
      return this.unknown(command, "journal-unavailable", true);
    }
  }
  async inspectApproval(command) {
    try {
      if (this.approvals === void 0) return { kind: "conflict" };
      return await this.approvals.inspect({
        sessionId: command.sessionId,
        approvalId: command.approvalId
      });
    } catch {
      return { kind: "conflict" };
    }
  }
  async executeStop(authority, command, row, onRequested) {
    const target = Object.freeze({
      sessionId: command.sessionId,
      turn: command.expectedActivityRevision
    });
    if (row.phase === "requested") {
      const recovered = await this.inspectStopped(target);
      if (recovered.kind === "stopped") return this.repairStopCommit(command, row, recovered);
      return this.stopUnknown(command, recovered.kind === "conflict" ? "stop-terminal-conflict" : "stop-settlement-pending", true);
    }
    const proofFailure = command.control.sessionId !== command.sessionId || command.control.holderDeviceId !== authority.deviceId;
    if (proofFailure) return this.rejectStop(row, command, "invalid-control-proof");
    const preflight = await this.authorizedAdmission(command, authority, () => void 0);
    if (preflight.kind === "threw") return this.rejectStop(row, command, "authorization-denied");
    if (preflight.kind === "refused") return this.rejectStop(row, command, preflight.errorCode);
    const prepared = await this.stops.prepare(target);
    if (!prepared.ok) {
      const code = prepared.error.code === "session-not-found" ? "session-not-found" : "activity-revision-stale";
      return this.rejectStop(row, command, code);
    }
    const admitted = await this.authorizedAdmission(command, authority, () => prepared.prepared.admit());
    if (admitted.kind === "threw") return this.stopUnknown(command, "stop-admission-outcome-unknown");
    if (admitted.kind === "refused") return this.rejectStop(row, command, admitted.errorCode);
    if (!admitted.value.ok) return this.rejectStop(row, command, "activity-revision-stale");
    try {
      await this.control.markCommandRequested(
        row.commandId,
        row.requestFingerprint,
        { targetTurn: command.expectedActivityRevision }
      );
    } catch {
      return this.stopUnknown(command, "journal-unavailable");
    }
    this.notifyStopRequested(onRequested, command, false);
    let settled;
    try {
      settled = await admitted.value.receipt.settle();
    } catch {
      return this.stopUnknown(command, "stop-settlement-unavailable");
    }
    if (!settled.durable || settled.inspection.kind !== "stopped") {
      return this.stopUnknown(
        command,
        settled.inspection.kind === "conflict" ? "stop-terminal-conflict" : "stop-settlement-unavailable"
      );
    }
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        targetTurn: command.expectedActivityRevision,
        turnEndSeq: settled.inspection.turnEndSeq
      });
    } catch (error) {
      this.logger.warn(`remote-command: durable Stop terminal committed but journal repair is pending: ${String(error)}`);
    }
    return Object.freeze({
      outcome: "stopped",
      commandId: command.commandId,
      expectedActivityRevision: command.expectedActivityRevision,
      replayed: false,
      currentRunning: settled.currentRunning
    });
  }
  async replayStopped(command, row) {
    if (!("turnEndSeq" in row.commit) || row.commit.targetTurn !== command.expectedActivityRevision) {
      return this.stopUnknown(command, "committed-fact-unavailable", true);
    }
    const inspection = await this.inspectStopped({
      sessionId: command.sessionId,
      turn: command.expectedActivityRevision
    });
    if (inspection.kind !== "stopped" || inspection.turnEndSeq !== row.commit.turnEndSeq) {
      return this.stopUnknown(command, "committed-fact-unavailable", true);
    }
    return stopTerminalFromRow(row, command.expectedActivityRevision, true);
  }
  async repairStopCommit(command, row, inspection) {
    try {
      await this.control.commitCommand(row.commandId, row.requestFingerprint, {
        targetTurn: command.expectedActivityRevision,
        turnEndSeq: inspection.turnEndSeq
      });
      return Object.freeze({
        outcome: "stopped",
        commandId: command.commandId,
        expectedActivityRevision: command.expectedActivityRevision,
        replayed: true
      });
    } catch {
      return this.stopUnknown(command, "journal-unavailable", true);
    }
  }
  async inspectStopped(target) {
    try {
      return await this.stops.inspect(target);
    } catch {
      return { kind: "conflict" };
    }
  }
  async rejectStop(row, command, errorCode) {
    try {
      const rejected = await this.control.rejectCommand(
        row.commandId,
        row.requestFingerprint,
        { code: errorCode }
      );
      return stopTerminalFromRow(rejected, command.expectedActivityRevision, false);
    } catch {
      return this.stopUnknown(command, "journal-unavailable");
    }
  }
  async reject(row, errorCode) {
    try {
      const rejected = await this.control.rejectCommand(
        row.commandId,
        row.requestFingerprint,
        { code: errorCode }
      );
      return terminalFromRow(rejected, false);
    } catch {
      return this.unknown({ commandId: row.commandId }, "journal-unavailable");
    }
  }
  async authorizedAdmission(command, authority, effect) {
    try {
      const result = await this.control.admit(command.control, () => {
        authority.authorize();
      }, effect);
      return result.ok ? { kind: "admitted", value: result.value } : { kind: "refused", errorCode: `control-${result.reason}` };
    } catch (error) {
      this.logger.warn(`remote-command: admission threw: ${String(error)}`);
      return { kind: "threw" };
    }
  }
  notifyReceived(callback, receipt) {
    if (callback === void 0) return;
    try {
      callback(Object.freeze({ ...receipt }));
    } catch (error) {
      this.logger.warn(`remote-command: received receipt delivery failed after durable reservation: ${String(error)}`);
    }
  }
  notifyStopRequested(callback, command, replayed) {
    if (callback === void 0) return;
    try {
      callback(Object.freeze({
        outcome: "requested",
        commandId: command.commandId,
        expectedActivityRevision: command.expectedActivityRevision,
        replayed
      }));
    } catch (error) {
      this.logger.warn(`remote-command: Stop requested delivery failed after durable state: ${String(error)}`);
    }
  }
  async awaitStop(operation, command, replayed) {
    let timer;
    const timeout = new Promise((resolve2) => {
      timer = setTimeout(() => {
        resolve2(this.stopUnknown(command, "stop-settlement-timeout", replayed));
      }, this.stopSettlementTimeoutMs);
    });
    try {
      const result = await Promise.race([operation, timeout]);
      return Object.freeze({ ...result, replayed: result.replayed || replayed });
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  }
  withReplay(result, replayed) {
    return Object.freeze({ ...result, replayed });
  }
  unknown(command, errorCode, replayed = false) {
    this.logger.warn(`remote-command: ${command.commandId} outcome unknown (${errorCode})`);
    console.error(`remote-command: ${command.commandId} outcome unknown (${errorCode})`);
    return Object.freeze({ outcome: "unknown", commandId: command.commandId, replayed, errorCode });
  }
  stopRejected(command, errorCode, replayed = false) {
    return Object.freeze({
      outcome: "rejected",
      commandId: command.commandId,
      expectedActivityRevision: command.expectedActivityRevision,
      replayed,
      errorCode
    });
  }
  stopUnknown(command, errorCode, replayed = false) {
    return Object.freeze({
      outcome: "unknown",
      commandId: command.commandId,
      expectedActivityRevision: command.expectedActivityRevision,
      replayed,
      errorCode
    });
  }
};

// ../host-workspace/deepseek-harness/packages/host/remote-command/src/workspace-bind.ts
var WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function sanitizeRemoteWorkspaceName(raw) {
  const name2 = raw.trim();
  if (name2.length < 1 || name2.length > 64) return void 0;
  if (name2 === "." || name2 === "..") return void 0;
  if (/[\\/<>:"|?*\u0000-\u001f]/.test(name2)) return void 0;
  if (WINDOWS_RESERVED.test(name2)) return void 0;
  return name2;
}
async function bindRemoteCreateWorkspace(input) {
  const parentId = input.workspaceId?.trim() || void 0;
  const rawName = input.newWorkspaceName;
  if (rawName !== void 0 && parentId === void 0) {
    return { ok: false, errorCode: "workspace-invalid-name" };
  }
  if (parentId === void 0) return { ok: true };
  let items;
  try {
    items = await input.list();
  } catch {
    return { ok: false, errorCode: "workspace-create-failed" };
  }
  const parent = items.find((item) => item.workspaceId === parentId);
  if (parent === void 0) return { ok: false, errorCode: "workspace-not-found" };
  if (rawName === void 0) return { ok: true, workspaceId: parent.workspaceId };
  const name2 = sanitizeRemoteWorkspaceName(rawName);
  if (name2 === void 0) return { ok: false, errorCode: "workspace-invalid-name" };
  let childPath;
  try {
    childPath = await input.mkdir(parent.path, name2);
  } catch {
    return { ok: false, errorCode: "workspace-create-failed" };
  }
  const registered = await input.register(childPath);
  if (!registered.ok) return { ok: false, errorCode: "workspace-create-failed" };
  return { ok: true, workspaceId: registered.workspaceId };
}

// ../host-workspace/deepseek-harness/packages/host/remote-command/src/index.ts
var name = "host-remote-command";
var inject = ["apiProxy", "remoteControl"];
var Config = src_default.object({
  stopSettlementTimeoutMs: src_default.number().step(1).min(1e3).max(3e5).default(3e4)
});
function request(payload) {
  return { rpcId: RpcId(`remote-command-${randomUUID()}`), payload };
}
function errorCodeOf(response, fallback) {
  if (response.result.ok) return fallback;
  return response.result.error.code;
}
async function mkdirChild(parentPath, name2) {
  const childPath = join(parentPath, name2);
  try {
    await mkdir(childPath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return childPath;
}
function createHostSessionAdmin(apiProxy) {
  const admin = {
    async createSession(input) {
      const bound = await bindRemoteCreateWorkspace({
        ...input.workspaceId === void 0 ? {} : { workspaceId: input.workspaceId },
        ...input.newWorkspaceName === void 0 ? {} : { newWorkspaceName: input.newWorkspaceName },
        list: async () => {
          const listed = await apiProxy.workspace.list(request({}));
          if (!listed.result.ok) throw new Error(listed.result.error.message);
          return listed.result.value.items.map((item) => ({
            workspaceId: String(item.workspaceId),
            path: item.path
          }));
        },
        mkdir: mkdirChild,
        register: async (path) => {
          const created = await apiProxy.workspace.create(request({ path }));
          if (!created.result.ok) {
            return { ok: false, errorCode: errorCodeOf(created, "workspace-create-failed") };
          }
          return { ok: true, workspaceId: String(created.result.value.workspace.workspaceId) };
        }
      });
      if (!bound.ok) return bound;
      const response = await apiProxy.sessions.create(request({
        sessionId: input.sessionId,
        ...input.agentPreset === void 0 ? {} : { agentPreset: input.agentPreset },
        ...bound.workspaceId === void 0 ? {} : { workspaceId: bound.workspaceId }
      }));
      if (!response.result.ok) {
        return { ok: false, errorCode: errorCodeOf(response, "session-admin-unavailable") };
      }
      return {
        ok: true,
        ...response.result.value.agentPreset === void 0 ? {} : { agentPreset: response.result.value.agentPreset }
      };
    },
    async selectAgentPreset(input) {
      const response = await apiProxy.agentPresets.select(request({
        sessionId: input.sessionId,
        agentPreset: input.agentPreset
      }));
      if (!response.result.ok) {
        return { ok: false, errorCode: errorCodeOf(response, "session-admin-unavailable") };
      }
      return { ok: true };
    },
    async selectModel(input) {
      const response = await apiProxy.sessions.selectModel(request({
        sessionId: input.sessionId,
        provider: input.provider,
        model: input.model,
        ...input.reasoningEffort === void 0 ? {} : { reasoningEffort: input.reasoningEffort }
      }));
      if (!response.result.ok) {
        return { ok: false, errorCode: errorCodeOf(response, "session-admin-unavailable") };
      }
      return { ok: true };
    },
    async forkSession(input) {
      const response = await apiProxy.sessions.fork(request({
        sessionId: input.sessionId,
        childSessionId: input.childSessionId,
        ...input.atSeq === void 0 ? {} : { atSeq: input.atSeq }
      }));
      if (!response.result.ok) {
        if (response.result.error.code === "workspace-attach-failed") {
          return { ok: true, childSessionId: input.childSessionId };
        }
        return { ok: false, errorCode: errorCodeOf(response, "session-admin-unavailable") };
      }
      return { ok: true, childSessionId: response.result.value.sessionId };
    }
  };
  return Object.freeze(admin);
}
function apply(ctx, config) {
  const gateway = ctx.apiProxy;
  const prompts = gateway.promptAdmissions ?? ctx.get("remotePromptAdmissions");
  if (prompts === void 0) {
    throw new Error("host-remote-command: apiProxy.promptAdmissions is missing");
  }
  const executor = new RemoteCommandExecutor(
    prompts,
    gateway.stopAdmissions,
    ctx.remoteControl,
    ctx.logger,
    config.stopSettlementTimeoutMs ?? 3e4,
    gateway.approvalInteractions,
    createHostSessionAdmin(ctx.apiProxy),
    // Lazy: the policy owner mounts with the remote carrier plugin, which may
    // load after this adapter; absence keeps policy commands honestly refused.
    () => ctx.get("remoteApprovalPolicy")
  );
  const disposeService = ctx.provide("remoteCommands", executor);
  ctx.effect(() => async () => {
    disposeService();
    await executor.close();
  }, "host-remote-command: command owner");
}
export {
  Config,
  apply,
  bindRemoteCreateWorkspace,
  inject,
  name,
  sanitizeRemoteWorkspaceName
};
