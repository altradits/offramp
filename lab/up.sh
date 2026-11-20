#!/bin/zsh
# Private regtest network: bitcoind + two LND nodes ("wallet" pays, "svc" is the off-ramp).
L=${0:A:h:h}
bitcoind -regtest -datadir=$L/btc -daemon -server -txindex -rpcuser=lab -rpcpassword=lab -rpcport=18543 -port=18544 -fallbackfee=0.0002
sleep 3
for n in svc:1 wallet:2; do name=${n%%:*}; i=${n##*:}
  ${LND:-lnd} --lnddir=$L/$name --bitcoin.regtest --bitcoin.node=bitcoind \
    --bitcoind.rpchost=127.0.0.1:18543 --bitcoind.rpcuser=lab --bitcoind.rpcpass=lab --bitcoind.rpcpolling \
    --rpclisten=127.0.0.1:1101$i --restlisten=127.0.0.1:809$i --listen=127.0.0.1:974$i \
    --noseedbackup --alias=$name --accept-keysend > $L/$name.log 2>&1 &
done
