const { ethers } = require('ethers');
const KuruSdk = require('@kuru-labs/kuru-sdk');
require('dotenv').config();

const RPC_URL = process.env.RPC_URL || 'https://rpc.monad.xyz';
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const USDC_ADDR = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const WMON_ADDR = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';
const KURU_MARKET = '0x065c9d28e428a0db40191a54d33d5b7c71a9c394';
const UNI_ROUTER = '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)'
];
const WMON_ABI = [
  'function withdraw(uint256 amount)',
  'function balanceOf(address) view returns (uint256)'
];
const UNI_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
];

async function recover() {
  const wallet = await signer.getAddress();
  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, signer);
  const wmon = new ethers.Contract(WMON_ADDR, WMON_ABI, signer);

  const usdcBal = await usdc.balanceOf(wallet);
  console.log('Current USDC Balance:', ethers.utils.formatUnits(usdcBal, 6), 'USDC');

  if (usdcBal.gt(0)) {
    const usdcStr = ethers.utils.formatUnits(usdcBal, 6);
    console.log('Attempting swap of ' + usdcStr + ' USDC for MON on Kuru...');

    try {
      const allowance = await usdc.allowance(wallet, KURU_MARKET);
      if (allowance.lt(usdcBal)) {
        console.log('Approving Kuru...');
        const appTx = await usdc.approve(KURU_MARKET, ethers.constants.MaxUint256);
        await appTx.wait();
        console.log('Kuru Approved!');
      }

      const params = await KuruSdk.ParamFetcher.getMarketParams(provider, KURU_MARKET);
      const tx = await KuruSdk.IOC.placeMarket(signer, KURU_MARKET, params, {
        approveTokens: false,
        size: usdcStr,
        isBuy: true,
        minAmountOut: '100',
        isMargin: false,
        fillOrKill: false,
        txOptions: { value: 0 }
      });

      if (tx && tx.hash) {
        console.log('Kuru Tx Hash:', tx.hash);
        await tx.wait();
        console.log('Kuru Swap Confirmed!');
      }
    } catch (kuruErr) {
      console.warn('Kuru swap failed, routing via Uniswap V3...');
      
      const uniAllowance = await usdc.allowance(wallet, UNI_ROUTER);
      if (uniAllowance.lt(usdcBal)) {
        console.log('Approving Uniswap V3...');
        const appTx = await usdc.approve(UNI_ROUTER, ethers.constants.MaxUint256);
        await appTx.wait();
        console.log('Uniswap V3 Approved!');
      }

      const router = new ethers.Contract(UNI_ROUTER, UNI_ROUTER_ABI, signer);
      const swapTx = await router.exactInputSingle({
        tokenIn: USDC_ADDR,
        tokenOut: WMON_ADDR,
        fee: 500,
        recipient: wallet,
        amountIn: usdcBal,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      }, { gasLimit: 350000 });

      console.log('Uniswap V3 Tx Hash:', swapTx.hash);
      await swapTx.wait();
      console.log('Uniswap V3 Swap Confirmed!');
    }
  }

  // Unwrap any WMON
  const wmonBal = await wmon.balanceOf(wallet);
  if (wmonBal.gt(0)) {
    console.log('Unwrapping ' + ethers.utils.formatEther(wmonBal) + ' WMON to Native MON...');
    const unwrapTx = await wmon.withdraw(wmonBal, { gasLimit: 150000 });
    await unwrapTx.wait();
    console.log('Unwrapped to Native MON!');
  }

  const finalMon = await provider.getBalance(wallet);
  console.log('\n====================================');
  console.log('  RECOVERY COMPLETE!               ');
  console.log('====================================');
  console.log('Final Native MON Balance:', ethers.utils.formatEther(finalMon), 'MON');
  console.log('====================================\n');
}

recover().catch(err => console.error('Recovery failed:', err.message));
