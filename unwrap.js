const { ethers } = require('ethers');
const { TOKENS } = require('./src/config'); // This pulls the correct address from your bot
require('dotenv').config();

const WMON_ABI = [
    'function withdraw(uint256 amount)', 
    'function balanceOf(address owner) view returns (uint256)'
];

async function recover() {
    console.log("--- Starting Recovery ---");
    const provider = new ethers.providers.JsonRpcProvider("https://rpc.monad.xyz");
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    // Use the address your bot uses
    const wmonAddress = TOKENS.WMON.address;
    console.log(`Targeting WMON at: ${wmonAddress}`);
    
    const wmon = new ethers.Contract(wmonAddress, WMON_ABI, signer);
    
    try {
        const bal = await wmon.balanceOf(signer.address);
        console.log(`Your WMON balance: ${ethers.utils.formatEther(bal)}`);
        
        if (bal.gt(0)) {
            console.log(`Unwrapping... please wait.`);
            const tx = await wmon.withdraw(bal, { gasLimit: 150000 });
            await tx.wait();
            console.log("Success! Your MON is now native again.");
        } else {
            console.log("No WMON found to unwrap.");
        }
    } catch (e) {
        console.log("Error during call:", e.message);
    }
}

recover();