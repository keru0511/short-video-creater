import { verifyApproval, ApprovalError } from './approval.js';
import { CliUsageError, runCli } from './cli-runner.js';

const usage = 'Usage: tsx src/approval-cli.ts --request <path> --receipt <path> --project-root <dir> [--now <ISO-8601>]';

interface ApprovalArgs {
  requestRel: string;
  receiptRel: string;
  projectRoot: string;
  now?: string;
}

function parseArgs(args: string[]): ApprovalArgs {
  let requestRel: string | undefined;
  let receiptRel: string | undefined;
  let projectRoot: string | undefined;
  let now: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--request') {
      requestRel = args[++i];
    } else if (arg === '--receipt') {
      receiptRel = args[++i];
    } else if (arg === '--project-root') {
      projectRoot = args[++i];
    } else if (arg === '--now') {
      now = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage);
      process.exit(0);
    }
  }

  if (!requestRel || !receiptRel || !projectRoot) {
    throw new CliUsageError();
  }

  return { requestRel, receiptRel, projectRoot, now };
}

async function main({ requestRel, receiptRel, projectRoot, now }: ApprovalArgs): Promise<number> {
  const result = await verifyApproval(projectRoot, requestRel, receiptRel, now ? { now } : undefined);
  console.log(JSON.stringify(result, null, 2));
  return result.approved ? 0 : 1;
}

runCli({
  argv: process.argv,
  parseArgs,
  main,
  usage,
  usageOutput: 'stdout',
  errorFormatter: (err) => {
    const code = err instanceof ApprovalError ? err.code : 'UNEXPECTED_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify(
      {
        approved: false,
        error: code,
        message,
        ...(err instanceof ApprovalError && err.decision ? { decision: err.decision, decisionPath: err.decisionPath } : {}),
      },
      null,
      2,
    );
  },
});
