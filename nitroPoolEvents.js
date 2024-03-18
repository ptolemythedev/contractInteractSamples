const ethers = require('ethers');
const axios = require('axios');
const moment = require('moment');
const ora = require('ora');
const { table } = require('table');

require('events').EventEmitter.defaultMaxListeners = 20;
const timeStampFormat = 'YYYY/MM/DD HH:mm'
const erc20ABI = ["function name() view returns (string)","function symbol() view returns (string)","function decimals() view returns (uint8)","function totalSupply() view returns (uint256)","function balanceOf(address account) view returns (uint256)","function transfer(address recipient, uint256 amount) returns (bool)","function allowance(address owner, address spender) view returns (uint256)","function approve(address spender, uint256 amount) returns (bool)","function transferFrom(address sender, address recipient, uint256 amount) returns (bool)","event Transfer(address indexed from, address indexed to, uint256 value)","event Approval(address indexed owner, address indexed spender, uint256 value)"];
const arbiscanApiKey = '5NCZP99H3XUVK4Z5UWQNQJV9DDHCHZ5GXR';
const blockChunkSize = 50000; // Reduce the chunk size to 10,000 to ensure we are well within limits
const rpcUrls = [
  "https://arb-mainnet.g.alchemy.com/v2/ayLI4xr8NNQN90i74vD11e9w2sSYdxrz",
  "https://arbitrum-mainnet.infura.io/v3/ff8ccca5f2ae445dae9b1d836b08045f",
  "https://arb1.arbitrum.io/rpc"
];

async function fetchAbi(contractAddress) {
  const response = await axios.get(`https://api.arbiscan.io/api?module=contract&action=getabi&address=${contractAddress}&apikey=${arbiscanApiKey}`);
  if (response.data.status !== "1") {
    throw new Error("Failed to fetch ABI");
  }
  return JSON.parse(response.data.result);
}

// Config
const nitroPoolAddress = '0x93b9965cdc531a2659d0982c83d2f56Dc01B9fBE';
const startBlock = 39952704;

async function main() {
  const providers = rpcUrls.map(url => new ethers.JsonRpcProvider(url));
  const provider = new ethers.FallbackProvider(providers);

  const nitroPoolABI = await fetchAbi(nitroPoolAddress);
  const nitroPoolContract = new ethers.Contract(nitroPoolAddress, nitroPoolABI, provider);

  // Getting RewardsTokens Symbols
  const [rewardsToken1Address,,,] = await nitroPoolContract.rewardsToken1()
  const [rewardsToken2Address,,,] = await nitroPoolContract.rewardsToken2()
  const rewardsToken1Contract = new ethers.Contract(rewardsToken1Address, erc20ABI, provider);
  const rewardsToken2Contract = new ethers.Contract(rewardsToken2Address, erc20ABI, provider);
  const rewardsToken1Symbol = await rewardsToken1Contract.symbol();
  const rewardsToken2Symbol = await rewardsToken2Contract.symbol();

  // Getting NitroPool Deposit Details
  const nftPoolAddress = await nitroPoolContract.nftPool();
  const nftPoolABI = await fetchAbi(nftPoolAddress);
  const nftPoolContract = new ethers.Contract(nftPoolAddress, nftPoolABI, provider);
  const [lpTokenAddress,,,,,,,] = await nftPoolContract.getPoolInfo();
  const lpTokenABI = await fetchAbi(lpTokenAddress);
  const lpTokenContract = new ethers.Contract(lpTokenAddress, lpTokenABI, provider);
  const token0Address = await lpTokenContract.token0();
  const token1Address = await lpTokenContract.token1();
  const token0Contract =  new ethers.Contract(token0Address, erc20ABI, provider);
  const token1Contract = new ethers.Contract(token1Address, erc20ABI, provider);
  const token0Symbol = await token0Contract.symbol();
  const token1Symbol = await token1Contract.symbol();

  // Getting NitroPool General Info
  const creationTime = await nitroPoolContract.creationTime();
  const formattedCreationTime = moment.unix(Number(creationTime)).format(timeStampFormat);

  // Getting NitroPool Settings
  const [startTime, endTime, harvestStartTime, depositEndTime, lockDurationReq, lockEndReq, depositAmountReq, whitelist, description] = await nitroPoolContract.settings();
  const formattedStartTime = moment.unix(Number(startTime)).format(timeStampFormat);
  const formattedEndTime = moment.unix(Number(endTime)).format(timeStampFormat);
  const formattedHarvestStartTime = moment.unix(Number(harvestStartTime)).format(timeStampFormat);
  const formattedDepositEndTime = moment.unix(Number(depositEndTime)).format(timeStampFormat);
  const formattedLockDurationReq = moment.duration(Number(lockDurationReq)).asDays();
  const formattedLockEndReq = moment.unix(Number(lockEndReq)).format(timeStampFormat);
  const formattedDepositAmountReq = ethers.formatEther(depositAmountReq);
  const publishTime = await nitroPoolContract.publishTime();
  const formattedPublishTime = moment.unix(Number(publishTime)).format(timeStampFormat);

  // Print NitroPool Info
  const data = [
    ['NitroPool', `${nitroPoolAddress}`],
    ['NFTPool', `${nftPoolAddress}`],
    ['LPToken', `${token0Symbol}-${token1Symbol} (${lpTokenAddress})`],
    ['RewardsToken1', `${rewardsToken1Symbol} (${rewardsToken1Address})`],
    ['RewardsToken2', `${rewardsToken2Symbol} (${rewardsToken2Address})`],
    ['Created On', `${formattedCreationTime}`],
    ['Published On', `${formattedPublishTime}`],
    ['StartTime', `${formattedStartTime}`],
    ['Harvest StartTime', `${formattedHarvestStartTime}`],
    ['Deposit EndTime', `${formattedDepositEndTime} (After ${moment.duration((Number(depositEndTime) - Number(startTime)) * 1000).asDays()} days of StartTime)`],
    ['EndTime', `${formattedEndTime} (After ${moment.duration((Number(endTime) - Number(startTime)) * 1000).asDays()} days of StartTime)`],
    ['Minimum Days spNFT to be locked', `${Number(lockDurationReq) > 0 ? formattedLockDurationReq : 'N/A'}`],
    ['spNFT should be locked at least until', `${Number(lockEndReq) > 0 ? formattedLockEndReq: 'N/A'}`],
    [`Minimum ${token0Symbol}-${token1Symbol} deposit required in the spNFT`, `${Number(depositAmountReq) > 0 ? formattedDepositAmountReq: 'N/A'}`],
    ['Whitelisting requirement for deposits', `${whitelist ? 'Required' : 'N/A'}`]
  ];

console.log(table(data));

  // Get the latest block number
  const latestBlock = await provider.getBlockNumber();
  let totalRewardsToken1Added = 0;
  let totalRewardsToken2Added = 0;
  let totalRewardsToken1Harvested = 0;
  let totalRewardsToken2Harvested = 0;
  let daysSinceStartTime = 0;
  
  // Query in chunks
  const spinner = ora(`Querying for events`).start();
  for (let fromBlock = startBlock; fromBlock <= latestBlock; fromBlock += blockChunkSize + 1) {
    let toBlock = fromBlock + blockChunkSize - 1;
    if (toBlock > latestBlock) {
      toBlock = latestBlock;
    }

    spinner.text = `Scanning block ${fromBlock} to ${toBlock} | ${totalRewardsToken1Added > 0 ? Math.round((100 * totalRewardsToken1Harvested / totalRewardsToken1Added) * 100) / 100 : 0}% ${rewardsToken1Symbol} Harvested | ${totalRewardsToken2Added > 0 ? Math.round((100 * totalRewardsToken2Harvested / totalRewardsToken2Added) * 100) / 100 : 0}% ${rewardsToken2Symbol} Harvested | ${daysSinceStartTime > 0 ? `${Math.floor(daysSinceStartTime)} days since StartTime` : `${Math.floor(-1 * daysSinceStartTime)} days to StartTime`}`;

    try {
      const addRewardsToken1events = await nitroPoolContract.queryFilter(nitroPoolContract.filters.AddRewardsToken1(), fromBlock, toBlock);
      const addRewardsToken2events = await nitroPoolContract.queryFilter(nitroPoolContract.filters.AddRewardsToken2(), fromBlock, toBlock);
      const harvestEvents = await nitroPoolContract.queryFilter(nitroPoolContract.filters.Harvest(null), fromBlock, toBlock); // First argument null to match any 'user'

      for (const event of addRewardsToken1events) {
        const block = await provider.getBlock(event.blockNumber);
        const date = new Date(block.timestamp * 1000);
        const formattedDate = moment(date).format(timeStampFormat);
        const [rewardsToken1Added,] = event.args;
        const rewardsToken1AddedFormatted = ethers.formatEther(rewardsToken1Added);
        spinner.clear();
        console.log(`${rewardsToken1AddedFormatted} ${rewardsToken1Symbol} ADDED on ${formattedDate}`);
        totalRewardsToken1Added = totalRewardsToken1Added + parseFloat(rewardsToken1AddedFormatted);
      };

      for (const event of addRewardsToken2events) {
        const block = await provider.getBlock(event.blockNumber);
        const date = new Date(block.timestamp * 1000);
        const formattedDate = moment(date).format(timeStampFormat);
        const [rewardsToken2Added,] = event.args;
        const rewardsToken2AddedFormatted = ethers.formatEther(rewardsToken2Added);
        spinner.clear();
        console.log(`${rewardsToken2AddedFormatted} ${rewardsToken2Symbol} ADDED on ${formattedDate}`);
        totalRewardsToken2Added = totalRewardsToken2Added + parseFloat(rewardsToken2AddedFormatted);
      };

      for (const event of harvestEvents) {
        const [, rewardsTokenAddress, rewardsTokenAmount] = event.args;
        const rewardsTokenAmountFormatted = ethers.formatEther(rewardsTokenAmount);

        if (ethers.getAddress(rewardsTokenAddress) === ethers.getAddress(rewardsToken1Address)) {
          totalRewardsToken1Harvested = totalRewardsToken1Harvested + parseFloat(rewardsTokenAmountFormatted)
        }
        
        if (ethers.getAddress(rewardsTokenAddress) === ethers.getAddress(rewardsToken2Address)) {
          totalRewardsToken2Harvested = totalRewardsToken2Harvested + parseFloat(rewardsTokenAmountFormatted)
        }
      };

      const block = await provider.getBlock(toBlock);
      daysSinceStartTime = moment.duration((block.timestamp - Number(startTime)) * 1000).asDays()

    } catch (error) {
      console.error(`Error fetching events from block ${fromBlock} to ${toBlock}:`, error);
      spinner.fail(`Failed between block ${fromBlock} to ${toBlock}`);
    }
  }

  spinner.succeed(`Finished querying ${latestBlock - startBlock} blocks`);

  // Print Summary
  const summary = [
    [`Total ${rewardsToken1Symbol} ADDED`, `${totalRewardsToken1Added}`],
    [`Total ${rewardsToken1Symbol} HARVESTED`, `${totalRewardsToken1Harvested}`],
    [`Total ${rewardsToken2Symbol} ADDED`, `${totalRewardsToken2Added})`],
    [`Total ${rewardsToken2Symbol} HARVESTED`, `${totalRewardsToken2Harvested})`],
  ];
  
  console.log(table(summary));
}

main().catch(error => {
  console.error(error);
});
