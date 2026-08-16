import process from 'node:process';

export class CliUsageError extends Error {}

export interface CliRunnerOptions<T> {
  argv?: string[];
  args?: string[];
  parseArgs: (args: string[]) => T;
  main: (args: T) => Promise<number | void>;
  usage: string;
  usageOutput?: 'stdout' | 'stderr' | 'both';
  errorFormatter?: (err: unknown) => string;
}

export async function runCli<T>(options: CliRunnerOptions<T>): Promise<never> {
  const args = options.args ?? options.argv?.slice(2) ?? process.argv.slice(2);
  try {
    const parsed = options.parseArgs(args);
    const exitCode = await options.main(parsed);
    process.exit(exitCode ?? 0);
  } catch (err) {
    if (err instanceof CliUsageError) {
      const output = options.usageOutput ?? 'stderr';
      if (output === 'stdout' || output === 'both') {
        console.log(options.usage);
      }
      if (output === 'stderr' || output === 'both') {
        console.error(options.usage);
      }
    } else {
      const format = options.errorFormatter ?? ((e) => (e instanceof Error ? e.message : String(e)));
      console.error(format(err));
    }
    process.exit(1);
  }
}
