resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  tags = {
    Name = "battleroom"
  }
}

resource "aws_subnet" "main" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "ap-south-1a"

  tags = {
    Name = "battleroom-public"
  }
}

resource "aws_internet_gateway" "gw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "IGW"
  }
}

resource "aws_route_table" "routing" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.gw.id
  }

  tags = {
    Name = "Routing"
  }
}

resource "aws_route_table_association" "glue" {
  subnet_id      = aws_subnet.main.id
  route_table_id = aws_route_table.routing.id
}

resource "aws_security_group" "battleroom" {
  name        = "battleroom"
  description = "Allow SSH, HTTP, HTTPS inbound traffic and all outbound traffic for battleroom"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "battleroom"
  }
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.battleroom.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 22
  ip_protocol       = "tcp"
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.battleroom.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  ip_protocol       = "tcp"
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.battleroom.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "all_out" {
  security_group_id = aws_security_group.battleroom.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "battleroom" {
  ami           = "ami-01a00762f46d584a1"
  instance_type = "t3.micro"

  subnet_id = aws_subnet.main.id

  vpc_security_group_ids = [
    aws_security_group.battleroom.id
  ]

  key_name = "battleroom-key"

  tags = {
    Name = "battleroom-server"
  }
}
resource "aws_eip" "eip" {
  domain = "vpc"

  tags = {
    Name = "battleroom-eip"
  }
}

resource "aws_eip_association" "battleroom" {
  instance_id  = aws_instance.battleroom.id
  allocation_id = aws_eip.eip.id
}

