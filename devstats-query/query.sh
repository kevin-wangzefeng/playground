#!/usr/bin/env bash


SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

PROJECTS=("$@")

pushd $SCRIPT_ROOT

DAY=$(date +"%Y-%m-%d")

echo "##### Running scripts for ${DAY} data ##########"
curl --version
jq --version
echo "###################################################"

# create dir with the date as name
mkdir -p ${DAY}

pushd ${DAY}

for PROJECT in "${PROJECTS[@]}"
do
  echo "$(date): running for ${PROJECT} overall stats"
  curl -X POST https://${PROJECT}.devstats.cncf.io/api/ds/query -H "Content-Type: application/json" -d "{\"queries\":[{\"refId\":\"A\",\"datasource\":{\"uid\":\"P172949F98CB31475\",\"type\":\"postgres\"},\"rawSql\":\"select name, value from \\\"spstat\\\" where series = 'pstatall' and period = 'y10'\",\"format\":\"table\",\"datasourceId\":1,\"intervalMs\":21600000,\"maxDataPoints\":1838}]}" > ./stats-${PROJECT}-${DAY}.json
  
  
  DATA=$(cat stats-${PROJECT}-${DAY}.json |jq -c '.results.A.frames[0].data')
  
  for KEY in "Stargazers" "Forkers" "Contributors" "Code committers"
  do
    KEY_INDEX=$(echo ${DATA}| jq -r '.values[0]' | jq "index(\"${KEY}\")")
    KEY_VALUE=$(echo ${DATA}|jq -r ".values[1][${KEY_INDEX}]")
    echo "$KEY|$DAY|$KEY_VALUE" >> contributors-${PROJECT}-${DAY}.txt
  done
done

popd

echo "############ Uploading ${DAY} data #############"

./obsutil config -i=${AK} -k=${SK} -e ${ENDPOINT}

./obsutil cp -r -f ${DAY} obs://cncf-devstats/

echo "############ Done for ${DAY} data ##############"
popd
