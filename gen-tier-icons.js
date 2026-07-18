const fs = require('fs');
const { createCanvas } = require('canvas');
const path = require('path');

const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir);
}

function drawIcon(size, text, bgType) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  const radius = size * 0.2;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(size - radius, 0);
  ctx.quadraticCurveTo(size, 0, size, radius);
  ctx.lineTo(size, size - radius);
  ctx.quadraticCurveTo(size, size, size - radius, size);
  ctx.lineTo(radius, size);
  ctx.quadraticCurveTo(0, size, 0, size - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.clip();

  if (bgType === 'pro') {
    ctx.fillStyle = '#1A1A1A'; // Premium Black
    ctx.fill();
  } else if (bgType === 'vip') {
    // Champagne Gold gradient
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#F5DEB3'); // Wheat/Champagne light
    gradient.addColorStop(1, '#D4AF37'); // Gold dark
    ctx.fillStyle = gradient;
    ctx.fill();
  } else {
    ctx.fillStyle = '#F0F0F0'; // Light gray default
    ctx.fill();
  }

  // Text
  if (bgType === 'pro') {
    ctx.fillStyle = '#FFFFFF';
  } else if (bgType === 'vip') {
    ctx.fillStyle = '#4A3B10'; // Dark gold/brown text for contrast
  } else {
    ctx.fillStyle = '#333333';
  }
  
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  // Font size heuristic
  const fontSize = size * 0.55;
  ctx.font = `bold ${fontSize}px "SF Pro Display", -apple-system, sans-serif`;
  ctx.fillText(text, size / 2, size / 2 + size * 0.05);

  return canvas.toBuffer('image/png');
}

sizes.forEach(size => {
  ['ZH', 'EN'].forEach(lang => {
    ['pro', 'vip'].forEach(bgType => {
      const buffer = drawIcon(size, lang, bgType);
      const filename = `${lang.toLowerCase()}-${bgType}-${size}.png`;
      fs.writeFileSync(path.join(iconsDir, filename), buffer);
      console.log(`Generated ${filename}`);
    });
  });
});
