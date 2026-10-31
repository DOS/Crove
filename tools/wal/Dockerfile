# The database image of a stack that archives its WAL (issue #2120, docs/runbooks/backup-and-restore.md, "Point in time
# recovery"): the PostgreSQL image of docker-compose.yml, unchanged, plus pgBackRest from the PostgreSQL project's own apt
# repository (already configured in the base image, signed). pgBackRest pushes every finished WAL segment to the backup
# bucket, encrypted (aes-256-cbc), takes the base backups and restores to a point in time.
#
# Its settings arrive as PGBACKREST_* environment variables (compose.wal.yml); there is no configuration file. The base
# image is pinned by digest, as every image is (AGENTS.md, "Updating pinned images"); keep it equal to the `db` image of
# docker-compose.yml (tools/test/wal-archiving.test.ts checks).
FROM postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3

# The 2.60 series: a rebuild takes its bug fixes, never a new minor version unseen.
RUN apt-get update \
    && apt-get install -y --no-install-recommends 'pgbackrest=2.60.*' \
    && rm -rf /var/lib/apt/lists/* \
    && pgbackrest version
