#!/usr/bin/env bash

# AUTHOR="foo@bar.com"
# SINCE_DATE="2022-01-01"
function contributions {
  git log --no-merges --since ${SINCE_DATE} --author "${AUTHOR}"  --numstat |\
    grep -v "vendor" |\
    grep -Pv "Date:|insertion|deletion|file|Bin|generated|yaml|html|go\.sum|\.proto" | sort -k3 |\
    grep -P "^\d+\t\d+" |\
    awk 'BEGIN{total=0}{total+=$1+$2}END{print total}'
}
