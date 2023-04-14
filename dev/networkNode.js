import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import Blockchain from './blockchain';
import { v1 as uuid } from 'uuid';
import rp from 'request-promise';

const app = express();
const port = process.argv[2];

const nodeAddress = uuid().split('-').join('');

const posicoin = new Blockchain();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/blockchain', function(req: Request, res: Response) {
  res.send(posicoin);
});

app.post('/transaction', function(req: Request, res: Response) {
  const newTransaction = req.body;
  const blockIndex = posicoin.addTransactionToPendingTransactions(newTransaction);
  res.json({ note: `Transaction will be added in block ${blockIndex}.` });
});

app.post('/transaction/broadcast', function(req: Request, res: Response) {
  const newTransaction = posicoin.createNewTransaction(req.body.amount, req.body.sender, req.body.recipient);
  posicoin.addTransactionToPendingTransactions(newTransaction);

  const requestPromises: Promise<any>[] = [];
  posicoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/transaction',
      method: 'POST',
      body: newTransaction,
      json: true
    };
    requestPromises.push(rp(requestOptions));
  });

  Promise.all(requestPromises)
  .then(data => {
    res.json({ note: 'Transaction created and broadcast successfully.' });
  });
});

app.get('/mine', function(req: Request, res: Response) {
  const lastBlock = posicoin.getLastBlock();
  const previousBlockHash = lastBlock['hash'];
  const currentBlockData = {
    transactions: posicoin.pendingTransactions,
    index: lastBlock['index'] + 1
  };
  const nonce = posicoin.proofOfWork(previousBlockHash, currentBlockData);
  const blockHash = posicoin.hashBlock(previousBlockHash, currentBlockData, nonce);
  const newBlock = posicoin.createNewBlock(nonce, previousBlockHash, blockHash);

  const requestPromises: Promise<any>[] = [];
  posicoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/receive-new-block',
      method: 'POST',
      body: { newBlock: newBlock },
      json: true
    };
    requestPromises.push(rp(requestOptions));
  });

  Promise.all(requestPromises)
  .then(data => {
    res.json({ note: 'New block mined and broadcast successfully.', block: newBlock });
  });
});

// receive new block
app.post('/receive-new-block', function(req, res) {
	const newBlock: Block = req.body.newBlock;
	const lastBlock: Block = posicoin.getLastBlock();
	const correctHash: boolean = lastBlock.hash === newBlock.previousBlockHash; 
	const correctIndex: boolean = lastBlock.index + 1 === newBlock.index;

	if (correctHash && correctIndex) {
		posicoin.chain.push(newBlock);
		posicoin.pendingTransactions = [];
		res.json({
			note: 'New block received and accepted.',
			newBlock: newBlock
		});
	} else {
		res.json({
			note: 'New block rejected.',
			newBlock: newBlock
		});
	}
});


// register a node and broadcast it the network
app.post('/register-and-broadcast-node', function(req, res) {
	const newNodeUrl: string = req.body.newNodeUrl;
	if (posicoin.networkNodes.indexOf(newNodeUrl) === -1) posicoin.networkNodes.push(newNodeUrl);

	const regNodesPromises: Promise<any>[] = [];
	posicoin.networkNodes.forEach((networkNodeUrl: string) => {
		const requestOptions: any = {
			uri: networkNodeUrl + '/register-node',
			method: 'POST',
			body: { newNodeUrl: newNodeUrl },
			json: true
		};

		regNodesPromises.push(rp(requestOptions));
	});

	Promise.all(regNodesPromises)
	.then((data: any) => {
		const bulkRegisterOptions: any = {
			uri: newNodeUrl + '/register-nodes-bulk',
			method: 'POST',
			body: { allNetworkNodes: [ ...posicoin.networkNodes, posicoin.currentNodeUrl ] },
			json: true
		};

		return rp(bulkRegisterOptions);
	})
	.then((data: any) => {
		res.json({ note: 'New node registered with network successfully.' });
	});
});


// register a node with the network
app.post('/register-node', function(req, res) {
	const newNodeUrl: string = req.body.newNodeUrl;
	const nodeNotAlreadyPresent: boolean = posicoin.networkNodes.indexOf(newNodeUrl) === -1;
	const notCurrentNode: boolean = posicoin.currentNodeUrl !== newNodeUrl;
	if (nodeNotAlreadyPresent && notCurrentNode) posicoin.networkNodes.push(newNodeUrl);
	res.json({ note: 'New node registered successfully.' });
});


// register multiple nodes at once
app.post('/register-nodes-bulk', function(req, res) {
	const allNetworkNodes: string[] = req.body.allNetworkNodes;
	allNetworkNodes.forEach((networkNodeUrl: string) => {
		const nodeNotAlreadyPresent: boolean = posicoin.networkNodes.indexOf(networkNodeUrl) === -1;
		const notCurrentNode: boolean = posicoin.currentNodeUrl !== networkNodeUrl;
		if (nodeNotAlreadyPresent && notCurrentNode) posicoin.networkNodes.push(networkNodeUrl);
	});

	res.json({ note: 'Bulk registration successful.' });
});
// consensus
app.get('/consensus', function(req, res) {
  const requestPromises: Promise<any>[] = [];
  posicoin.networkNodes.forEach(networkNodeUrl => {
    const requestOptions = {
      uri: networkNodeUrl + '/blockchain',
      method: 'GET',
      json: true
    };

    requestPromises.push(rp(requestOptions));
  });

  Promise.all(requestPromises)
  .then(blockchains => {
    const currentChainLength = posicoin.chain.length;
    let maxChainLength = currentChainLength;
    let newLongestChain: Block[] | null = null;
    let newPendingTransactions: Transaction[] | null = null;

    blockchains.forEach(blockchain => {
      if (blockchain.chain.length > maxChainLength) {
        maxChainLength = blockchain.chain.length;
        newLongestChain = blockchain.chain;
        newPendingTransactions = blockchain.pendingTransactions;
      }
    });

    if (!newLongestChain || (newLongestChain && !posicoin.chainIsValid(newLongestChain))) {
      res.json({
        note: 'Current chain has not been replaced.',
        chain: posicoin.chain
      });
    } else {
      posicoin.chain = newLongestChain;
      posicoin.pendingTransactions = newPendingTransactions;
      res.json({
        note: 'This chain has been replaced.',
        chain: posicoin.chain
      });
    }
  });
});

// get block by blockHash
app.get('/block/:blockHash', function(req, res) { 
  const blockHash = req.params.blockHash;
  const correctBlock = posicoin.getBlock(blockHash);
  res.json({
    block: correctBlock
  });
});

// get transaction by transactionId
app.get('/transaction/:transactionId', function(req, res) {
  const transactionId = req.params.transactionId;
  const transactionData: TransactionData = posicoin.getTransaction(transactionId);
  res.json({
    transaction: transactionData.transaction,
    block: transactionData.block
  });
});

// get address by address
app.get('/address/:address', function(req, res) {
  const address = req.params.address;
  const addressData = posicoin.getAddressData(address);
  res.json({
    addressData: addressData
  });
});

// block explorer
app.get('/block-explorer', function(req, res) {
  res.sendFile('./block-explorer/index.html', { root: __dirname });
});

app.listen(port, function() {
  console.log(`Listening on port ${port}...`);
});




