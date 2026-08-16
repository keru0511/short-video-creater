import { verifyReleaseReadiness, ReadinessError } from './release-readiness.js';
import { runCli } from './cli-runner.js';

const usage =
  'Usage: tsx src/release-readiness-cli.ts --project-root <dir> --mp4 <rel> --audit <rel> --decision <rel> [--now <ISO-8601>] [--output-rel <rel>] [--max-json-bytes <bytes>] [--max-artifact-bytes <bytes>]';

interface ReadinessArgs {
  projectRoot: string;
  mp4Rel: string;
  auditRel: string;
  decisionRel: string;
  now?: string;
  outputRel?: string;
  maxJsonBytes?: number;
  maxArtifactBytes?: number;
}

function parseNumber(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new ReadinessError(`${name} must be a positive integer`, 'INVALID_SIZE_LIMIT');
  }
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ReadinessError(`${name} must be a positive integer, got ${value}`, 'INVALID_SIZE_LIMIT');
  }
  if (n > Number.MAX_SAFE_INTEGER) {
    throw new ReadinessError(`${name} exceeds safe integer limit`, 'INVALID_SIZE_LIMIT');
  }
  return n;
}

function parseArgs(args: string[]): ReadinessArgs {
  let projectRoot: string | undefined;
  let mp4Rel: string | undefined;
  let auditRel: string | undefined;
  let decisionRel: string | undefined;
  let now: string | undefined;
  let outputRel: string | undefined;
  let maxJsonBytes: number | undefined;
  let maxArtifactBytes: number | undefined;

  const seen = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) {
      throw new ReadinessError(`Duplicate option: ${arg}`, 'INVALID_CLI_ARGUMENT');
    }
    seen.add(arg);

    const requireNext = (): string => {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new ReadinessError(`${arg} requires a value`, 'INVALID_CLI_ARGUMENT');
      }
      return value;
    };
    const requireNumber = (name: string): number => {
      const value = requireNext();
      return parseNumber(value, name);
    };

    if (arg === '--project-root') {
      projectRoot = requireNext();
    } else if (arg === '--mp4') {
      mp4Rel = requireNext();
    } else if (arg === '--audit') {
      auditRel = requireNext();
    } else if (arg === '--decision') {
      decisionRel = requireNext();
    } else if (arg === '--now') {
      now = requireNext();
    } else if (arg === '--output-rel') {
      outputRel = requireNext();
    } else if (arg === '--max-json-bytes') {
      maxJsonBytes = requireNumber('--max-json-bytes');
    } else if (arg === '--max-artifact-bytes') {
      maxArtifactBytes = requireNumber('--max-artifact-bytes');
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage);
      process.exit(0);
    } else {
      throw new ReadinessError(`Unknown option: ${arg}`, 'INVALID_CLI_ARGUMENT');
    }
  }

  if (!projectRoot || !mp4Rel || !auditRel || !decisionRel) {
    throw new ReadinessError('Missing required options', 'INVALID_CLI_ARGUMENT');
  }

  return { projectRoot, mp4Rel, auditRel, decisionRel, now, outputRel, maxJsonBytes, maxArtifactBytes };
}

async function main({
  projectRoot,
  mp4Rel,
  auditRel,
  decisionRel,
  now,
  outputRel,
  maxJsonBytes,
  maxArtifactBytes,
}: ReadinessArgs): Promise<void> {
  const result = await verifyReleaseReadiness(projectRoot, mp4Rel, auditRel, decisionRel, {
    now,
    readinessOutputRel: outputRel,
    maxJsonBytes,
    maxArtifactBytes,
  });
  console.log(JSON.stringify(result, null, 2));
}

runCli({
  argv: process.argv,
  parseArgs,
  main,
  usage,
  errorFormatter: (err) => {
    const code = err instanceof ReadinessError ? err.code : 'UNEXPECTED_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ ready: false, error: code, message }, null, 2);
  },
});
