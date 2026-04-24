export interface CompletionOption {
  long: string | null;
  short: string | null;
  description: string;
  takesValue: boolean;
  choices: readonly string[] | null;
}

export interface CompletionArg {
  name: string;
  required: boolean;
  variadic: boolean;
  choices: readonly string[] | null;
}

export interface CompletionNode {
  name: string;
  description: string;
  options: readonly CompletionOption[];
  args: readonly CompletionArg[];
  subcommands: readonly CompletionNode[];
}
