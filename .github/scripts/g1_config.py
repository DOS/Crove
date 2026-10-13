"""Write the CI gitleaks config: repo rules plus the G1 blocklist from an Actions secret.

The blocklist (one literal identifier per line: Supabase project refs, org ids,
internal hostnames) lives only in the G1_BLOCKLIST secret, so the public repo never
names it. Fork PRs get no secrets; the generic G1 rules in .gitleaks.toml still run.
"""

import os
import re
import sys

out_path = sys.argv[1]
repo_config = os.path.join(os.environ.get("GITHUB_WORKSPACE", os.getcwd()), ".gitleaks.toml")
entries = [line.strip() for line in os.environ.get("G1_BLOCKLIST", "").splitlines() if line.strip()]

lines = ["[extend]", f"path = '''{repo_config}'''", ""]
if entries:
    pattern = "|".join(re.escape(e) for e in entries)
    if "'''" in pattern:
        sys.exit("G1_BLOCKLIST entries must not contain triple quotes")
    lines += [
        "[[rules]]",
        'id = "g1-blocklist"',
        'description = "Blocklisted internal identifier (G1)"',
        f"regex = '''(?i)(?:{pattern})'''",
        "",
    ]
    print(f"G1 blocklist rule added ({len(entries)} entries).")
else:
    print("::notice::G1_BLOCKLIST is not available (fork PR or unset); scanning with repo rules only.")

with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
