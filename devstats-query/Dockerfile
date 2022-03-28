FROM ubuntu:20.04

RUN apt-get update && \
    apt-get install -y curl jq

COPY obsutil_linux_amd64_5.3.4/obsutil .
COPY query.sh .
RUN chmod +x query.sh

CMD ["query.sh"]

