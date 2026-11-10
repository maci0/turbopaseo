// Parses diff-probe output as the files of a `checkout_diff_update` with the protocol's schema.
import { readFileSync } from "node:fs";
import { CheckoutDiffUpdateSchema } from "@getpaseo/protocol/messages";

const files: unknown = JSON.parse(readFileSync(process.argv[2], "utf8"));
const result = CheckoutDiffUpdateSchema.safeParse({
  type: "checkout_diff_update",
  payload: { subscriptionId: "s1", cwd: "/repo", files, error: null },
});
if (!result.success) {
  console.error(JSON.stringify(result.error.issues));
  process.exit(1);
}
console.log("valid checkout_diff_update");
