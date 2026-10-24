import { execFileSync } from "node:child_process";
const bucket = process.argv[2];
if (!/^[a-z0-9-]{3,63}$/.test(bucket ?? ""))
  throw Error("Pass the private deployment bucket name");
const aws = (args) =>
  execFileSync("aws", [...args, "--region", "us-west-1"], {
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
try {
  aws(["s3api", "head-bucket", "--bucket", bucket]);
} catch {
  aws([
    "s3api",
    "create-bucket",
    "--bucket",
    bucket,
    "--create-bucket-configuration",
    "LocationConstraint=us-west-1",
  ]);
}
aws([
  "s3api",
  "put-public-access-block",
  "--bucket",
  bucket,
  "--public-access-block-configuration",
  JSON.stringify({
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  }),
]);
aws([
  "s3api",
  "put-bucket-encryption",
  "--bucket",
  bucket,
  "--server-side-encryption-configuration",
  JSON.stringify({
    Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
  }),
]);
aws([
  "s3api",
  "put-bucket-versioning",
  "--bucket",
  bucket,
  "--versioning-configuration",
  "Status=Enabled",
]);
aws([
  "s3api",
  "put-bucket-policy",
  "--bucket",
  bucket,
  "--policy",
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TLSOnly",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  }),
]);
aws([
  "s3api",
  "put-bucket-lifecycle-configuration",
  "--bucket",
  bucket,
  "--lifecycle-configuration",
  JSON.stringify({
    Rules: [
      {
        ID: "BoundOldReleases",
        Status: "Enabled",
        Filter: { Prefix: "releases/" },
        NoncurrentVersionExpiration: { NoncurrentDays: 14 },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      },
    ],
  }),
]);
console.log(`Private encrypted versioned storage ready: ${bucket}`);
