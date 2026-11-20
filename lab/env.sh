L=${${(%):-%x}:A:h:h}
bcli(){ bitcoin-cli -regtest -datadir=$L/btc -rpcuser=lab -rpcpassword=lab -rpcport=18543 "$@"; }
svc(){ lncli --lnddir=$L/svc --network=regtest --rpcserver=127.0.0.1:11011 "$@"; }
wal(){ lncli --lnddir=$L/wallet --network=regtest --rpcserver=127.0.0.1:11012 "$@"; }
