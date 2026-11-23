// A zod-like schema type: `_input` is what callers must send.
export interface Schema<Input, Output = Input> {
  _input: Input;
  _output: Output;
  parse(data: unknown): Output;
}

export declare const createUserSchema: Schema<{ name: string; email?: string; role?: 'admin' | 'member' }>;
