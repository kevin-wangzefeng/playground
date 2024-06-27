#!/usr/bin/env bash

# AUTHOR="foo@bar.com"
# SINCE_DATE="2022-01-01"
function contributions {
  git log --no-merges --since ${SINCE_DATE} --author "${AUTHOR}"  --numstat |\
    grep -v "vendor" |\
    grep -Pv "Date:|insertion|deletion|file|Bin|\.svg|generated|yaml|\.json|html|go\.sum|\.pb\.go|\.pb-c|\=\>" | sort -k3 |\
    grep -P "^\d+\t\d+" |\
    awk 'BEGIN{total=0}{total+=$1+$2}END{print total}'
}

# AUTHOR="foo@bar.com"
# SINCE_DATE="2022-01-01"
# UNTIL_DATE="2023-01-01"
function contributions-period {
  git log --no-merges --since ${SINCE_DATE} --until ${UNTIL_DATE} --author "${AUTHOR}"  --numstat |\
    grep -v "vendor" |\
    grep -Pv "Date:|insertion|deletion|file|Bin|\.svg|generated|yaml|\.json|html|go\.sum|\.pb\.go|\.pb-c|\=\>" | sort -k3 |\
    grep -P "^\d+\t\d+" |\
    awk 'BEGIN{total=0}{total+=$1+$2}END{print total}'
}

# AUTHOR="foo@bar.com"
# SINCE_DATE="2022-01-01"
# UNTIL_DATE="2023-01-01"
function changes-period {
  git log --no-merges --since ${SINCE_DATE} --until ${UNTIL_DATE} --author "${AUTHOR}"  --numstat |\
    grep -v "vendor" |\
    grep -Pv "Date:|insertion|deletion|file|Bin|\.svg|generated|yaml|\.json|html|go\.sum|\.pb\.go|\.pb-c|\=\>" |\
    grep -P "^\d+\t\d+|^commit|^Author"
}
