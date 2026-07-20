export type CommandGroup = 'discover' | 'manage' | 'develop' | 'declarative' | 'maintain';
export type OptionValueShape = 'boolean' | 'required' | 'optional';
export type OptionRelationKind =
  | 'conflicts'
  | 'requires'
  | 'distinct-values'
  | 'cardinality'
  | 'exclusive-group'
  | 'scope-consistency';

export interface CommandArgumentSpec {
  readonly name: string;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly choices: readonly string[];
  readonly defaultValue: unknown;
  readonly description?: string;
}

export interface CommandOptionSpec {
  readonly flags: string;
  readonly long: string;
  readonly short: string | null;
  readonly attributeName: string;
  readonly valueShape: OptionValueShape;
  readonly knownValues: readonly string[];
  readonly allowedValues: readonly string[];
  /** Values enforced directly by Commander before application validation. */
  readonly parserValues?: readonly string[];
  readonly repeatable: boolean;
  readonly negated: boolean;
  /** Value represented by absence/presence in the external flag contract. */
  readonly flagDefault: unknown;
  /** Value presented to an application request after parser normalization. */
  readonly parsedDefault: unknown;
  readonly description?: string;
}

export interface CommandExitCodeSpec {
  readonly code: number;
  readonly meaning: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly path: string;
  readonly aliases: readonly string[];
  readonly group: CommandGroup;
  readonly primaryQuestion: string;
  readonly description: string;
  readonly arguments: readonly CommandArgumentSpec[];
  readonly options: readonly CommandOptionSpec[];
  readonly examples: readonly string[];
  /** Command-specific meanings shown in generated help. */
  readonly exitCodes?: readonly CommandExitCodeSpec[];
  readonly capability: string;
  readonly application: string;
  readonly reportKind?: string;
}

interface OptionRelationBase {
  readonly id: string;
  readonly command: string;
  readonly description: string;
}

export type OptionRelationSpec =
  | (OptionRelationBase & {
      readonly kind: 'conflicts';
      readonly options: readonly [string, string];
    })
  | (OptionRelationBase & {
      readonly kind: 'requires';
      readonly option: string;
      readonly requiredOption: string;
    })
  | (OptionRelationBase & {
      readonly kind: 'distinct-values';
      readonly option: string;
    })
  | (OptionRelationBase & {
      readonly kind: 'exclusive-group';
      readonly options: readonly string[];
    })
  | (OptionRelationBase & {
      readonly kind: 'scope-consistency';
      readonly scopeOption: string;
      readonly sugars: readonly {
        readonly option: string;
        readonly value: string;
      }[];
    })
  | (OptionRelationBase & {
      readonly kind: 'cardinality';
      readonly subject: 'positionals' | 'option-occurrences';
      readonly whenOption: string;
      readonly option?: string;
      readonly exact?: number;
      readonly maximum?: number;
      readonly label: string;
    });

export interface OptionInvocationError {
  readonly code: 'usage';
  readonly exitCode: 2;
  readonly message: string;
}

export type OptionInvocationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: OptionInvocationError };
