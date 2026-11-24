const { test } = require("node:test");
const assert = require("node:assert/strict");
const { healthTargetFingerprint } = require("../dist/services/health-target");

test("tracks the effective PostgreSQL target and excludes passwords", () => {
  const first = healthTargetFingerprint(
    "postgresql://monitor:first@localhost:5432/app",
  );
  assert.equal(
    first,
    healthTargetFingerprint("postgresql://monitor:second@localhost:5432/app"),
  );
  assert.notEqual(
    first,
    healthTargetFingerprint("postgresql://monitor:first@localhost:5432/other"),
  );
  assert.notEqual(
    first,
    healthTargetFingerprint(
      "postgresql://monitor:first@localhost:5432/app?host=otherhost",
    ),
  );
  assert.notEqual(
    first,
    healthTargetFingerprint("postgresql://other:first@localhost:5432/app"),
  );
  assert.match(first, /^[a-f0-9]{64}$/);
});
