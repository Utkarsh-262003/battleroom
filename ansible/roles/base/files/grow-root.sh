#!/bin/bash
# Grows the partition and ext4 filesystem behind a mount point to fill
# its disk. Needed after the EBS volume is made bigger: the disk grows,
# but the partition and filesystem keep their old size until this runs.
# Works while the server is running.
#
# Prints "grown" when the filesystem got bigger, and "skipped" or
# "already fills the disk" when there was nothing to do.

set -euo pipefail

mountpoint="${1:-/}"
fstype=$(findmnt -n -o FSTYPE "$mountpoint")

if [[ "$fstype" != ext* ]]; then
  echo "skipped: $mountpoint is $fstype, not ext"
  exit 0
fi

# Ubuntu on EC2 often shows the root device as /dev/root, which is not
# a real device file. The kernel's major:minor number finds the real one.
majmin=$(findmnt -n -o MAJ:MIN "$mountpoint" | tr -d ' ')
sysdir=$(readlink -f "/sys/dev/block/$majmin")

if [ ! -r "$sysdir/partition" ]; then
  echo "skipped: $mountpoint is not on a partition"
  exit 0
fi

part="/dev/$(basename "$sysdir")"
disk="/dev/$(basename "$(dirname "$sysdir")")"
number=$(cat "$sysdir/partition")
before=$(df -B1 --output=size "$mountpoint" | tail -n 1 | tr -d " ")

# Step 1: grow the partition. growpart exits 1 and prints NOCHANGE
# when the partition already fills the disk.
if ! output=$(growpart "$disk" "$number" 2>&1) && ! grep -q NOCHANGE <<< "$output"; then
  echo "$output" >&2
  exit 1
fi

# Step 2: grow the filesystem to fill the partition. This runs every
# time, not only right after step 1: if an earlier run grew the
# partition but not the filesystem, this finishes the job. When there
# is nothing to do, resize2fs changes nothing.
resize2fs "$part" >&2

after=$(df -B1 --output=size "$mountpoint" | tail -n 1 | tr -d " ")

if [ "$after" -gt "$before" ]; then
  echo "grown: $part went from $((before / 1048576)) MB to $((after / 1048576)) MB"
else
  echo "already fills the disk: $part"
fi
