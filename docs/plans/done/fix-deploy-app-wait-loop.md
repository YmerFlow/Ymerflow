# Report yf-deploy-app Job failure immediately instead of after a 7-minute timeout

## Goal

`prod/runall-minikube.sh` Step 9 waits for the `yf-deploy-app` Job with
`kubectl wait --for=condition=complete ... --timeout=420s`. `kubectl wait` on `condition=complete`
only wakes up on the `Complete` condition — it does not return early when the Job instead reaches
the terminal `Failed` condition (`backoffLimit: 0`, so a Job that crashes fails permanently within
seconds). Verified live: running `kubectl wait --for=condition=complete` against an already-`Failed`
Job still blocks for the full `--timeout` before erroring out. So a Job that dies in ~90 seconds
(e.g. the alembic `CREATE TYPE ... already exists` failure seen 2026-07-18) isn't reported until the
full 420s elapses — a crash looks like a 7-minute hang. Replace the single `kubectl wait` call with
a poll loop that checks for `Complete` or `Failed` and returns as soon as either is true.

Note: the *inner* migration-Job wait (`_wait_for_job_complete` in
`backend/services/app_deployment.py:290-308`, which `yf-deploy-app` itself runs and blocks
on) already polls for both `Complete` and `Failed` correctly and raises immediately on failure — it
is not part of this fix. Only the outer `kubectl wait` in `prod/runall-minikube.sh` has the bug.

## Current state

`prod/runall-minikube.sh:485-494`:

```bash
# apply_app_workloads runs the DB migration Job to completion inside this Job, so allow generous
# time (migrations + Kueue-independent workload apply). On failure, dump the deploy Job's logs
# before exiting so the migration/apply error is visible.
if ! kubectl wait --for=condition=complete job/yf-deploy-app -n nagelfluh --timeout=420s; then
    echo "  yf-deploy-app Job did not complete — logs follow:"
    kubectl logs job/yf-deploy-app -n nagelfluh || true
    exit 1
fi
kubectl logs job/yf-deploy-app -n nagelfluh
kubectl delete job yf-deploy-app -n nagelfluh
```

## Open design decision

Poll interval for the replacement loop: **2 seconds**. Fine-grained enough to report a fast crash
almost immediately, coarse enough not to hammer the API server over a worst-case ~210-iteration
wait. Flag if a different interval is preferred.

## Change

### `prod/runall-minikube.sh`

Replace the `kubectl wait` block (lines 488-492) with a poll loop that checks the Job's `Complete`
and `Failed` conditions directly, keeping the same 420s deadline as a fallback (covers the case
where the Job never reaches either terminal condition, e.g. stuck `Pending` on image pull) and the
same on-failure behavior (dump logs, `exit 1`):

```bash
deploy_app_deadline=$((SECONDS + 420))
while true; do
    complete=$(kubectl get job/yf-deploy-app -n nagelfluh \
        -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null)
    failed=$(kubectl get job/yf-deploy-app -n nagelfluh \
        -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null)
    [ "$complete" = "True" ] && break
    if [ "$failed" = "True" ]; then
        echo "  yf-deploy-app Job failed — logs follow:"
        kubectl logs job/yf-deploy-app -n nagelfluh || true
        exit 1
    fi
    if [ "$SECONDS" -ge "$deploy_app_deadline" ]; then
        echo "  yf-deploy-app Job did not complete — logs follow:"
        kubectl logs job/yf-deploy-app -n nagelfluh || true
        exit 1
    fi
    sleep 2
done
```

(`SECONDS` is a bash builtin — seconds elapsed since the shell started/was reset — no external
timer needed; `runall-minikube.sh` is already bash, confirmed by its shebang.)

The two lines after the current `if` block (`kubectl logs ...` / `kubectl delete job ...`) are
unchanged — they only run once the loop `break`s on success.

## Verification

- Reproduce the current failure (or force one, e.g. temporarily point `BACKEND_IMAGE` at a bad tag)
  and confirm the script reports the failure and exits within a few seconds of the Job's `Failed`
  condition appearing, not after 420s.
- Run `prod/runall-minikube.sh` end to end against a healthy stack and confirm Step 9 still
  succeeds and proceeds to Step 10 exactly as before (no change to the success path).
- Confirm `kubectl get job/yf-deploy-app ...` jsonpath queries return empty string (not an
  error) when the Job doesn't exist yet, so the loop doesn't spuriously break/exit before the Job
  object is visible (`kubectl apply` immediately precedes the loop, so this should be racing at
  most one poll interval, but worth confirming during verification).
