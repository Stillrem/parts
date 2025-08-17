
exports.handler = async (event) => {
  const q = event.queryStringParameters.q || "";
  if(q === "__demo"){
    return {
      statusCode: 200,
      body: JSON.stringify({results:[
        {name:"Washer Pump", partNumber:"W11259006", price:"$45.99", url:"#", image:"https://via.placeholder.com/150"},
        {name:"Motor", partNumber:"M12345", price:"$89.50", url:"#", image:"https://via.placeholder.com/150"},
        {name:"Knob", partNumber:"K54321", price:"$12.00", url:"#", image:"https://via.placeholder.com/150"}
      ]})
    };
  }
  return { statusCode: 200, body: JSON.stringify({results: []}) };
};
