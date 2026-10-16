#!/usr/bin/env bash
# Differential dispatcher check for the roadmap portal.
#
# Builds tests/differential_harness.cpp twice -- once against a pristine checkout of the pre-fix
# revision (default f3c5e1d) and once against the working tree under test -- starts each on a real
# localhost port with a harness-only .env (closed database port, throwaway passwords), replays an
# identical request set, and diffs the results.
#
# Both sides are built with the repository's own CMake flags, so the only difference between the
# two binaries is the source revision.
#
# The revision checkout is never modified: it is verified pristine, copied, and only the copy gets
# the harness target.
#
# Usage:
#   tests/run_dispatcher_differential.sh [--old-root DIR] [--old-ref REF] [--out DIR] \
#                                       [--revert-unstaged f1,f2,...]
#
# Exit status: 0 when the run completed (differences are printed, not judged), 1 on a build or run
# error. Interpreting the differences is the caller's job -- see the report.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEW_ROOT="$(cd "$HERE/.." && pwd)"
OLD_REF="f3c5e1d"
OLD_ROOT=""
OUT=""
PORT_OLD=18091
PORT_NEW=18092
REVERT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --old-root) OLD_ROOT="$2"; shift 2 ;;
        --old-ref)  OLD_REF="$2";  shift 2 ;;
        --out)      OUT="$2";      shift 2 ;;
        --revert-unstaged) REVERT="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

[[ -n "$OLD_ROOT" ]] || OLD_ROOT="$(dirname "$NEW_ROOT")/s1-old-$OLD_REF"
[[ -n "$OUT" ]] || OUT="${TMPDIR:-/tmp}/s1-differential.$$"
mkdir -p "$OUT"

old_sha="$(git -C "$OLD_ROOT" rev-parse HEAD)"
new_sha="$(git -C "$NEW_ROOT" rev-parse HEAD)"
echo "old root : $OLD_ROOT @ $old_sha"
echo "new root : $NEW_ROOT @ $new_sha"
if [[ "${old_sha:0:7}" != "${OLD_REF:0:7}" ]]; then
    echo "REFUSING: old root is not at $OLD_REF" >&2
    exit 2
fi
# The old checkout must be pristine: the comparison is only meaningful if its server code is the
# revision's own.
if [[ -n "$(git -C "$OLD_ROOT" status --porcelain)" ]]; then
    echo "REFUSING: old root has uncommitted changes" >&2
    git -C "$OLD_ROOT" status --porcelain >&2
    exit 2
fi

# ---- old side: a copy with the harness target added; the checkout itself is untouched ----
OLD_SRC="$OUT/oldsrc"
rm -rf "$OLD_SRC"
mkdir -p "$OLD_SRC"
tar -C "$OLD_ROOT" --exclude=./build --exclude=./.git -cf - . | tar -C "$OLD_SRC" -xf -
cp "$NEW_ROOT/tests/differential_harness.cpp" "$OLD_SRC/tests/differential_harness.cpp"
cat >> "$OLD_SRC/CMakeLists.txt" <<'EOF'

add_executable(differential_harness tests/differential_harness.cpp ${ENGINE_SOURCES})
target_link_libraries(differential_harness PRIVATE pthread mysqlclient curl ssl crypto)
EOF
echo "[old] added to the copy: tests/differential_harness.cpp + one CMake target"
# include/ and lib/ are gitignored local build dependencies (vendored OpenSSL headers and .so
# files); they are not part of the revision, so they are copied from the working tree so that
# both sides build against the same ones.
for d in include lib; do
    if [[ -d "$NEW_ROOT/$d" && ! -d "$OLD_SRC/$d" ]]; then
        cp -a "$NEW_ROOT/$d" "$OLD_SRC/$d"
        echo "[old] copied local build dependency $d/ (gitignored, not part of the revision)"
    fi
done
if diff <(git -C "$OLD_ROOT" show "$old_sha:CMakeLists.txt") <(head -n -3 "$OLD_SRC/CMakeLists.txt") > /dev/null; then
    echo "[old] the copy's CMakeLists differs from $OLD_REF only by the appended target"
else
    echo "[old] WARNING: the copy's CMakeLists differs from $OLD_REF by more than the appended target" >&2
fi

build_side() {
    local src="$1" tag="$2"
    cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release > "$OUT/cmake-$tag.log" 2>&1 \
        || { echo "[build:$tag] cmake configure failed; see $OUT/cmake-$tag.log" >&2; return 1; }
    grep -E "Build revision" "$OUT/cmake-$tag.log" | sed "s/^/[$tag] /"
    cmake --build "$src/build" --target differential_harness -j 8 > "$OUT/build-$tag.log" 2>&1 \
        || { echo "[build:$tag] build failed; see $OUT/build-$tag.log" >&2; tail -20 "$OUT/build-$tag.log" >&2; return 1; }
    echo "[build:$tag] ok -> $src/build/differential_harness"
}

# ---- new side: a copy of the working tree with files that are modified but NOT part of the
# change under test restored from HEAD, so a difference can be attributed to the change and not to
# somebody else's in-flight work. The working tree itself is never touched. ----
NEW_SRC="$OUT/newsrc"
rm -rf "$NEW_SRC"
mkdir -p "$NEW_SRC"
tar -C "$NEW_ROOT" --exclude=./build --exclude=./.git --exclude=./include --exclude=./lib \
    -cf - . | tar -C "$NEW_SRC" -xf -
for d in include lib; do [[ -d "$NEW_ROOT/$d" ]] && cp -a "$NEW_ROOT/$d" "$NEW_SRC/$d"; done
if [[ -n "$REVERT" ]]; then
    echo "[new] reverting these files from HEAD in the copy (declared as unrelated in-flight work):"
    IFS=',' read -ra _rev <<< "$REVERT"
    for f in "${_rev[@]}"; do
        [[ -z "$f" ]] && continue
        echo "      $f"
        git -C "$NEW_ROOT" show "HEAD:$f" > "$NEW_SRC/$f" || { echo "cannot revert $f" >&2; exit 2; }
    done
else
    echo "[new] no files reverted: the copy is the working tree as it stands"
fi

build_side "$OLD_SRC" "old"  || exit 3
build_side "$NEW_SRC" "new"  || exit 3

# Harness run directory: a .env that cannot reach a real store.
RUN="$OUT/run"
mkdir -p "$RUN"
cat > "$RUN/.env" <<'EOF'
# Harness-only configuration. Not a real environment file; contains no production values.
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3399
MYSQL_USER=harness
MYSQL_PASSWORD=harness-not-a-real-password
DATABASE_NAME=harness_nodb
SESSION_PASSWORD=harness-session-secret
OPERATOR_PASSWORD=harness-operator-secret
EOF

run_side() {
    local tag="$1" port="$2" bin="$3"
    ( cd "$RUN" && timeout 180 "$bin" "$port" "$OUT/result-$tag.txt" > "$OUT/server-$tag.log" 2>&1 )
    local rc=$?
    echo "[run:$tag] rc=$rc  $(grep -c '^REQ' "$OUT/result-$tag.txt" 2>/dev/null) result lines"
    return 0
}
run_side "old" "$PORT_OLD" "$OLD_SRC/build/differential_harness"
run_side "new" "$PORT_NEW" "$NEW_SRC/build/differential_harness"

RES_OLD="$OUT/result-old.txt"
RES_NEW="$OUT/result-new.txt"
echo
echo "===== diff: old ($old_sha) vs new ($new_sha) ====="
diff -u "$RES_OLD" "$RES_NEW" && echo "(identical)"
echo
echo "===== bypass / legit statuses ====="
printf '%-32s %-13s %-13s %s\n' LABEL OLD NEW VERDICT
awk 'FNR==NR{ if ($3 ~ /^(BYPASS|LEGIT)/) old[$3]=$5; next }
     ($3 ~ /^(BYPASS|LEGIT)/) { n=$5; o=old[$3]; v="";
        if ($3 ~ /^BYPASS/) {
            if (o ~ /status=(200|303)/ && n ~ /status=(401|403|404)/) v="CLOSED";
            else if (n ~ /status=(200|303)/) v="STILL OPEN";
            else v="CHECK";
        } else { v = (o==n) ? "unchanged" : "CHANGED"; }
        printf "%-32s %-13s %-13s %s\n", $3, o, n, v }' "$RES_OLD" "$RES_NEW"
echo
echo "results: $RES_OLD  $RES_NEW"
