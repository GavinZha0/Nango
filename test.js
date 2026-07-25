const text = '手机号是18611815495。'; 
console.log(text.match(/\b(1[3-9]\d)(\d{4})(\d{4})\b/g)); 
console.log(text.match(/(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)/g));
