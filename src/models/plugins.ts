import type { Document, Schema, Types } from 'mongoose';

/** Consistent JSON shape: `id` instead of `_id`, no `__v`, and per-schema hidden fields. */
export function jsonPlugin(schema: Schema, options: { hidden?: string[] } = {}): void {
  const hidden = options.hidden ?? [];
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform(_doc: unknown, ret: Record<string, unknown>) {
      ret.id = String(ret._id);
      delete ret._id;
      for (const f of hidden) delete ret[f];
      return ret;
    },
  });
}

/**
 * Financial records are append-only: block deletes on the model. Corrections are recorded as
 * new adjustment documents instead.
 */
export function noDeletePlugin(schema: Schema): void {
  const block = (): never => {
    throw new Error('Financial records cannot be deleted');
  };
  schema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], { document: true, query: true }, block);
}

/** Raw (schema) fields of a hydrated document. */
type RawOf<D> = D extends Document<unknown, unknown, infer R> ? R : never;

/** ObjectIds serialise to strings in JSON responses. */
type Serialised<T> = T extends Types.ObjectId
  ? string
  : T extends Date
    ? Date
    : T extends Array<infer U>
      ? Array<Serialised<U>>
      : T extends object
        ? { [K in keyof T]: Serialised<T[K]> }
        : T;

/**
 * The JSON shape produced by `jsonPlugin`: schema fields (ObjectIds as strings) with `_id`
 * replaced by a string `id`. Virtuals are included at runtime but not typed here.
 */
export type Json<D> = Omit<Serialised<RawOf<D>>, '_id' | '__v'> & { id: string };

export function toJson<D extends Document>(doc: D): Json<D> {
  return doc.toJSON() as unknown as Json<D>;
}
