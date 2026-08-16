import { verifyApproval, ApprovalError, canonicalSha256 } from './approval.js';

function printUsage(): void {
  console.log('Usage: tsx src/approval-cli.ts --request <path> --receipt <path> --project-root <dir> [--now <ISO-8601>]');
}

function parseArgs(argv: string[]): { requestRel: string; receiptRel: string; projectRoot: string; now?: string } {
  let requestRel: string | undefined;
  let receiptRel: string | undefined;
  let projectRoot: string | undefined;
  let now: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--request') {
      requestRel = argv[++i];
    } else if (arg === '--receipt') {
      receiptRel = argv[++i];
    } else if (arg === '--project-root') {
      projectRoot = argv[++i];
    } else if (arg === '--now') {
      now = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!requestRel || !receiptRel || !projectRoot) {
    printUsage();
    process.exit(1);
  }

  return { requestRel, receiptRel, projectRoot, now };
}

async function main(): Promise<void> {
  const { requestRel, receiptRel, projectRoot, now } = parseArgs(process.argv);
  try {
    const result = await verifyApproval(projectRoot, requestRel, receiptRel, now ? { now } : undefined);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.approved ? 0 : 1);
  } catch (err) {
    const code = err instanceof ApprovalError ? err.code : 'UNEXPECTED_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify(
        {
          approved: false,
          error: code,
          message,
          ...(err instanceof ApprovalError && err.decision
            ? { decision: err.decision, decisionPath: err.decisionPath }
            : {}),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
